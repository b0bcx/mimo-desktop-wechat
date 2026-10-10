/**
 * WeChat ↔ MiMo bridge.
 *
 * Owns one logged-in bot account and one long-poll monitor. Inbound text is
 * routed by `SessionRouter`; the reply is either a command answer or the agent's
 * final text, posted back to the same conversation.
 *
 * Proactive push is the other half of "还会主动联系你": any process on this
 * machine can enqueue a notification via `notify()`, and the plugin's
 * `session.post` hook does exactly that when a session finishes.
 *
 * @module mimo-desktop-wechat/bridge
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ChannelMonitor, sendText, type InboundMessage } from '../core/channel.ts'
import type { WeixinAccount } from '../core/types.ts'
import { SendRefusedError } from '../core/http.ts'
import {
  SessionRouter,
  type BindingStore,
  type SessionBinding,
  type SessionGateway,
} from '../core/router.ts'
import {
  DEFAULT_SETTINGS,
  StateStore,
  expirePendingNotifications,
  queuePendingNotification,
  resolveSettings,
  type ChannelState,
} from '../core/state.ts'
import { mimoStateDir } from './mimo-gateway.ts'
import { describeCurrentModel, renderModelList, resolveModelQuery, LANE_LABEL } from './models.ts'

export interface BridgeOptions {
  account: WeixinAccount
  gateway: SessionGateway
  stateFile?: string
  /** Called with every outbound WeChat text, for logging. */
  onLog?: (line: string) => void
  /** Extra text prepended to every agent prompt (the "you are on WeChat" note). */
  presenceNote?: string
}

export interface NotifyOptions {
  /** Conversation to push to. Defaults to the most recently used binding. */
  conversationId?: string
  text: string
  /** Optional local file path to send after the text. */
  path?: string
}

/**
 * One account's end-to-end channel: inbound pump + session routing + reply loop.
 */
export class WechatMimoBridge {
  readonly #options: BridgeOptions
  readonly #state: StateStore
  readonly #router: SessionRouter
  #monitor: ChannelMonitor | undefined
  #controller: AbortController | undefined
  #contextTokens: Map<string, string> = new Map()
  /** conversationId → last outbound contextToken, used for proactive sends. */
  #lastPeerByConversation: Map<string, string> = new Map()

  constructor(options: BridgeOptions) {
    this.#options = options
    const home = mimoStateDir()
    this.#state = new StateStore(options.stateFile || join(home, 'wechat', 'state.json'))
    this.#router = new SessionRouter({
      gateway: options.gateway,
      store: bindingStoreFromState(this.#state),
    })
  }

  /** Start the long-poll loop. Resolves when the loop stops. */
  async start(): Promise<void> {
    const account = this.#options.account
    const state = await this.#state.read()
    this.#monitor = new ChannelMonitor({
      account,
      initialSyncBuf: state.syncBufs[account.accountId] ?? '',
      onSyncBuf: async (buf) => {
        await this.#state.update((s) => {
          s.syncBufs[account.accountId] = buf
        })
      },
      onMessage: (msg) => this.#handleInbound(msg),
      onError: (error) => this.#log(`[error] ${errorText(error)}`),
      onStop: (reason, detail) => this.#log(`[stop] ${reason}${detail ? ` — ${detail}` : ''}`),
    })
    this.#controller = new AbortController()
    this.#log(`[start] account=${account.accountId} user=${account.userId ?? '?'}`)
    await this.#monitor.run(this.#controller.signal)
  }

  /** Stop the long-poll loop. */
  async stop(): Promise<void> {
    this.#controller?.abort()
    await this.#monitor?.notifyStop()
    this.#controller = undefined
    this.#monitor = undefined
  }

  /**
   * Push a proactive message to WeChat.
   *
   * The reply window is opened by an inbound message, so a push that arrives
   * while the window is closed is refused. That refusal is queued (durable) and
   * flushed on the next inbound, which is how "做完了告诉我" survives a silent
   * conversation.
   */
  async notify(options: NotifyOptions): Promise<{ delivered: boolean; queued?: boolean }> {
    const state = await this.#state.read()
    const settings = resolveSettings(state)
    const conversationId = options.conversationId || this.#pickConversation(state)
    if (!conversationId) {
      this.#log('[notify] no bound conversation yet — user must message the bot first')
      return { delivered: false }
    }

    const account = this.#options.account
    const peerId = peerFromConversation(conversationId) || account.userId || ''
    const contextToken = this.#contextTokens.get(conversationId)

    try {
      await sendText({
        account,
        to: peerId,
        text: chunkText(options.text, settings.maxReplyChars),
        ...(contextToken === undefined ? {} : { contextToken }),
      })
      this.#log(`[notify] delivered to ${conversationId}`)
      return { delivered: true }
    } catch (error) {
      if (error instanceof SendRefusedError) {
        await this.#state.update((s) => {
          queuePendingNotification(s, {
            conversationId,
            text: options.text,
            ...(options.path === undefined ? {} : { path: options.path }),
          })
        })
        this.#log(`[notify] refused (window closed), queued: ${error.message}`)
        return { delivered: false, queued: true }
      }
      this.#log(`[notify] failed: ${errorText(error)}`)
      return { delivered: false }
    }
  }

  async #handleInbound(msg: InboundMessage): Promise<void> {
    const account = this.#options.account
    const state = await this.#state.read()
    const settings = resolveSettings(state)

    // Remember the reply token for this conversation so later proactive sends work.
    if (msg.contextToken) {
      this.#contextTokens.set(msg.conversationId, msg.contextToken)
      await this.#state.update((s) => {
        const perAccount = (s.contextTokens[account.accountId] ??= {})
        perAccount[msg.conversationId] = msg.contextToken!
      })
    }
    this.#lastPeerByConversation.set(msg.conversationId, msg.peerId)

    // Flush anything that was queued while the window was closed.
    await this.#flushPending(msg.conversationId)

    const text = (msg.text || '').trim()
    if (!text) {
      // Media-only: tell the agent the attachment exists; full media download is phase 2.
      const note = `[收到附件 ${msg.media?.length ?? 0} 个]`
      await this.#dispatchPrompt(msg, note)
      return
    }

    // /model is host-specific (MiMo desktop picker), handled before the generic router.
    if (/^\/model(?:$|[\s:0-9a-zA-Z\-])/i.test(text)) {
      const reply = await this.#handleModelCommand(text)
      if (reply !== undefined) {
        await this.#replyTo(msg, reply)
        return
      }
    }

    // Plain-language model queries go to the same handler. Left to the agent they are
    // answered from its built-in provider catalog — dozens of models that were never
    // configured here — which reads as "a bunch of models I never set up".
    const intent = modelIntent(text)
    if (intent !== undefined) {
      const reply = await this.#handleModelCommand(intent)
      if (reply !== undefined) {
        await this.#replyTo(msg, reply)
        return
      }
    }

    const routed = await this.#router.route({
      conversationId: msg.conversationId,
      accountId: msg.accountId,
      peerId: msg.peerId,
      text,
    })

    if (routed.kind === 'reply') {
      await this.#replyTo(msg, routed.text)
      return
    }

    await this.#dispatchPrompt(msg, routed.decision.prompt, routed.decision.sessionId)
  }

  async #dispatchPrompt(msg: InboundMessage, prompt: string, sessionId?: string): Promise<void> {
    const presence = this.#options.presenceNote ?? DEFAULT_SETTINGS.presenceNote
    const body = `${presence}\n\n${prompt}`
    const sid = sessionId || (await this.#router.current(msg.conversationId))?.sessionId || ''
    if (!sid) {
      await this.#replyTo(msg, '内部错误：找不到会话绑定。')
      return
    }

    const gateway = this.#options.gateway as SessionGateway & {
      promptAndCapture?: (sessionId: string, text: string) => Promise<string>
    }

    try {
      // Prefer capture (standalone CLI path): one prompt, one reply back to WeChat.
      // The plugin path streams via `session.post` / `send_to_wechat` instead.
      if (typeof gateway.promptAndCapture === 'function') {
        const reply = await gateway.promptAndCapture(sid, body)
        await this.#replyTo(msg, reply)
      } else {
        await gateway.prompt(sid, body)
      }
    } catch (error) {
      await this.#replyTo(msg, `处理失败：${errorText(error)}`)
    }
  }

  async #handleModelCommand(text: string): Promise<string | undefined> {
    const gateway = this.#options.gateway as SessionGateway & {
      model?: string
      setModel?: (id: string) => Promise<void>
    }
    if (typeof gateway.setModel !== 'function') return undefined

    const rest = text.replace(/^\/model/i, '').replace(/^[:\s]+/, '').trim()
    if (!rest) {
      const cur = await describeCurrentModel(gateway.model ?? '')
      return `当前模型：${cur}\n\n发送 /model 看列表（含你配置的全部供应商），或 /model <模型id> 切换。`
    }

    const choice = await resolveModelQuery(rest)
    if (!choice) {
      const list = await renderModelList(gateway.model ?? '')
      return `没认出模型「${rest}」。\n\n${list}`
    }

    await gateway.setModel(choice.id)
    if (!choice.id) {
      this.#log(`[model] → default (follow config)`)
      return `已切换到「跟随配置」。\n之后回复用宿主默认模型。`
    }
    this.#log(`[model] → ${choice.id}`)
    return `已切换模型：${choice.label}\n${choice.id}\n链路：${LANE_LABEL[choice.lane]}\n${choice.hint}`
  }

  async #replyTo(msg: InboundMessage, text: string): Promise<void> {
    const account = this.#options.account
    const settings = resolveSettings(await this.#state.read())
    const body = chunkText(text, settings.maxReplyChars)
    try {
      const result = await sendText({
        account,
        to: msg.peerId,
        text: body,
        ...(msg.contextToken === undefined ? {} : { contextToken: msg.contextToken }),
      })
      await this.#state.update((s) => {
        const history = ((s.sentMessages[account.accountId] ??= {})[msg.conversationId] ??= [])
        history.push({
          messageId: result.serverMessageId || result.clientId,
          kind: 'text',
          preview: body.slice(0, 80),
          at: Date.now(),
        })
        if (history.length > 40) history.splice(0, history.length - 40)
      })
    } catch (error) {
      this.#log(`[reply] failed: ${errorText(error)}`)
    }
  }

  async #flushPending(conversationId: string): Promise<void> {
    await this.#state.update((s) => {
      expirePendingNotifications(s)
    })
    const state = await this.#state.read()
    const queue = state.pendingNotifications ?? []
    const mine = queue.filter((n) => n.conversationId === conversationId)
    if (mine.length === 0) return

    for (const item of mine) {
      await this.notify({ conversationId, text: item.text, ...(item.path === undefined ? {} : { path: item.path }) })
    }
    await this.#state.update((s) => {
      s.pendingNotifications = (s.pendingNotifications ?? []).filter((n) => n.conversationId !== conversationId)
    })
  }

  #pickConversation(state: ChannelState): string | undefined {
    const bindings = Object.values(state.bindings ?? {})
    if (bindings.length === 0) return undefined
    bindings.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return bindings[0].conversationId
  }

  #log(line: string): void {
    this.#options.onLog?.(line)
    if (!this.#options.onLog) {
      console.log(`[mimo-wechat] ${line}`)
    }
  }
}

/**
 * Recognise plain-language requests for the model list / current model.
 *
 * Returns the `/model …` command to run, or `undefined` to let the message through
 * to the router and agent. Deliberately narrow: only short, list-or-current shaped
 * questions. Anything longer or more specific ("这个报错和模型有关吗") belongs to
 * the agent, which can reason; hijacking it would answer the wrong question.
 */
export function modelIntent(text: string): string | undefined {
  const t = text.trim().replace(/[\s，。？！?!、~～.·…]/g, '')
  if (!t || t.length > 16) return undefined
  // 查看模型 / 模型列表 / 看看模型 / 有哪些模型 / 帮我看看有哪些模型 …
  if (/^(?:请问|帮我|我想)?(?:查看|看(?:看|一下|下)?|列出|显示|查询|查)?(?:有哪些|有什么|都是哪些|当前|现在|可用|全部|所有)?的?(?:模型|模型列表|模型清单)(?:有哪些|有什么|列表|清单|啊|呀|呗)?$/.test(t)) {
    return '/model'
  }
  if (/^(?:有哪些|有什么|都有哪些|都是些)(?:的)?模型(?:啊|呀|呗)?$/.test(t)) return '/model'
  // 当前在用什么模型 / 现在用的什么模型
  if (/^(?:当前|现在)(?:在|是)?用?的?(?:是)?什么模型$|^(?:当前|现在)模型$/.test(t)) return '/model'
  // 换模型 / 切换模型（无参数 → 出列表让人挑）
  if (/^(?:换|切换|换个|想换|要换)(?:一下)?模型(?:列表)?$/.test(t)) return '/model'
  return undefined
}

function bindingStoreFromState(state: StateStore): BindingStore {
  return {
    async load() {
      return (await state.read()).bindings ?? {}
    },
    async save(bindings: Record<string, SessionBinding>) {
      await state.update((s) => {
        s.bindings = bindings
      })
    },
  }
}

/** `accountId:peerId` or `accountId:groupId:peerId` → peerId */
function peerFromConversation(conversationId: string): string | undefined {
  const parts = conversationId.split(':')
  return parts.length >= 2 ? parts[parts.length - 1] : undefined
}

/** Split a long reply so WeChat's message limit is respected. */
function chunkText(text: string, max: number): string {
  const body = text.trim()
  if (body.length <= max) return body
  return `${body.slice(0, max - 20)}\n\n…（已截断，全文见会话）`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Persist a standalone notify request (used by the CLI). */
export async function enqueueNotifyFile(text: string, conversationId?: string): Promise<void> {
  const home = mimoStateDir()
  await mkdir(join(home, 'notify'), { recursive: true })
  const file = join(home, 'notify', `${Date.now()}.json`)
  await writeFile(file, JSON.stringify({ text, conversationId, queuedAt: Date.now() }), 'utf-8')
}

/** Read notify files the CLI left behind. */
export async function drainNotifyFiles(): Promise<{ text: string; conversationId?: string }[]> {
  const dir = join(mimoStateDir(), 'notify')
  try {
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    const out: { text: string; conversationId?: string }[] = []
    for (const f of files) {
      try {
        const raw = await readFile(join(dir, f), 'utf-8')
        const parsed = JSON.parse(raw) as { text: string; conversationId?: string }
        out.push(parsed)
        const { rm } = await import('node:fs/promises')
        await rm(join(dir, f), { force: true })
      } catch {
        // skip unreadable
      }
    }
    return out
  } catch {
    return []
  }
}
