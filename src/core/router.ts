/**
 * Conversation routing: one WeChat conversation maps to one DSH session, and the
 * user switches between them with in-chat commands.
 *
 * Why commands rather than a picker: WeChat gives a channel exactly one chat
 * surface, so a session list has to live inside the message stream. Tencent's own
 * client uses the same technique (it handles `/echo` and `/toggle-debug` in chat),
 * and the protocol's tool-call item types could eventually render something
 * richer. Commands work today, on every client, with no extra payload.
 *
 * Session ids are minted by this router in DSH's own format (`session-<uuid>`) and
 * handed to the session controller, which adopts an existing session with that id
 * or creates one. The mapping is what survives a restart, so a chat keeps talking
 * to the same session across reboots.
 *
 * @module @dsh-wechat/core/router
 */

import { randomUUID } from 'node:crypto'

/** One conversation's binding to a DSH session. */
export interface SessionBinding {
  conversationId: string
  accountId: string
  peerId: string
  /** DSH session id, in the platform's own `session-<uuid>` form. */
  sessionId: string
  /** Human label shown in `/list`, captured when the session was bound. */
  title: string
  createdAt: number
  lastUsedAt: number
}

/**
 * The single session every WeChat conversation maps to.
 *
 * WeChat is one person on one phone — there is nothing for a second session to
 * distinguish, and a pile of `微信 <random>` rows only made `/list` noise and
 * made it unclear which conversation was *the* WeChat one. One channel, one
 * session, one stable name.
 */
export const WECHAT_SESSION_TITLE = 'MiMo微信'

/**
 * Fixed id for that session, in the same `session-<8hex>-<uuid>` shape
 * `mintSessionId` produces so `/list` short ids and `/switch` keep working.
 * The hex spells "mimo…"; it never changes, so bindings survive restarts
 * without consulting the alias table at all.
 */
export const CANONICAL_SESSION_ID = 'session-6d696d6f-6d696d6f-8000-6d696d6f7763'

/** Why the router handed work to the agent, for logging. */
export interface RouteDecision {
  /** Session the prompt belongs to. */
  sessionId: string
  /** Text to send to the agent. */
  prompt: string
  /** True when this message started a brand new session. */
  created: boolean
}

/** Result of routing one message. */
export type RouteResult =
  | { kind: 'reply'; text: string }
  | { kind: 'prompt'; decision: RouteDecision }

/**
 * The session surface this router needs from the host.
 *
 * Keeping it narrow means the routing rules are unit-testable without booting DSH,
 * and it documents exactly which host calls the channel depends on.
 */
export interface SessionGateway {
  /** Bind or resume a session with this id. Implementations should be idempotent. */
  ensureSession(sessionId: string, title: string): Promise<void>
  /** Hand a prompt to a session. */
  prompt(sessionId: string, text: string): Promise<void>
  /** Recent sessions, newest first, for `/list`. */
  listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]>
  /**
   * Sessions belonging to the channel's own workspace.
   *
   * Optional because only the host knows where a session lives. `/list` uses it to lead with the
   * conversations this chat created and merely mention the rest; without it, every session is
   * treated as the channel's own and the list shows the whole machine.
   */
  listOwnSessions?(): Promise<{ sessionId: string; title: string; updatedAt: number }[]>
  /** Abort whatever the session is currently doing. */
  cancel(sessionId: string): Promise<void>
}

/** Everything persisted for routing, injected so the store stays pluggable. */
export interface BindingStore {
  load(): Promise<Record<string, SessionBinding>>
  save(bindings: Record<string, SessionBinding>): Promise<void>
}

export interface SessionRouterOptions {
  gateway: SessionGateway
  store: BindingStore
  /** Display name used when auto-creating a session title. */
  titlePrefix?: string
}

/**
 * Routes WeChat messages to DSH sessions and implements the in-chat commands.
 */
export class SessionRouter {
  readonly #gateway: SessionGateway
  readonly #store: BindingStore
  readonly #titlePrefix: string
  #bindings: Record<string, SessionBinding> | undefined
  /**
   * The rows the user was last shown by `/list`, per conversation.
   *
   * `/switch` numbers resolve against this rather than re-deriving a list, so a replied
   * number always means the line on the phone screen — including `/list all` interleaving
   * and a `/list 10` cut that the default ordering alone would not reproduce.
   */
  #lastList: Map<string, { sessionId: string; title: string; updatedAt: number }[]> = new Map()

  constructor(options: SessionRouterOptions) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? WECHAT_SESSION_TITLE
  }

  /**
   * Route one inbound message.
   *
   * @param params.conversationId - Stable conversation key.
   * @param params.accountId - Bot account the message arrived on.
   * @param params.peerId - Counterparty user id.
   * @param params.text - Message text.
   * @returns Either text to reply with directly, or a prompt for a session.
   */
  async route(params: {
    conversationId: string
    accountId: string
    peerId: string
    text: string
  }): Promise<RouteResult> {
    const text = params.text.trim()

    if (text.startsWith('/')) {
      return await this.#command(params, text)
    }

    /*
     * Plain-language session control, decided *before* the agent sees the message.
     *
     * A bare number after `/list`, "换个对话", "切换到3" — these are instructions to the
     * channel, not prompts. Sent through, the agent can only answer "我这边不会自动
     * 切换会话", which is true and useless: the binding lives here, not in its session.
     * Matching stays narrow (see `sessionIntent`) so real questions still reach the agent.
     */
    const intent = sessionIntent(text)
    if (intent !== undefined) {
      return await this.#command(params, intent.args ? `${intent.command} ${intent.args}` : intent.command)
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    if (binding === undefined) {
      binding = await this.#bind(params)
      created = true
    } else {
      // DSH may have restarted since this binding was made; make sure the session
      // is live before handing it a prompt.
      await this.#gateway.ensureSession(binding.sessionId, binding.title)
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)

    return {
      kind: 'prompt',
      decision: { sessionId: binding.sessionId, prompt: text, created },
    }
  }

  /** Currently bound session for a conversation, if any. */
  async current(conversationId: string): Promise<SessionBinding | undefined> {
    return (await this.#load())[conversationId]
  }

  async #command(
    params: { conversationId: string; accountId: string; peerId: string },
    text: string,
  ): Promise<RouteResult> {
    const { command, args } = splitCommand(text)
    const bindings = await this.#load()

    switch (command) {
      case '/help':
        return { kind: 'reply', text: HELP_TEXT }

      case '/mimowechat': {
        const binding = await this.#bind(params)
        // WeChat has exactly one session (see CANONICAL_SESSION_ID), so `/mimowechat`
        // re-adopts it rather than minting a sibling — the binding must always point at
        // *the* session or the next message lands somewhere the user did not ask for.
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return {
          kind: 'reply',
          text:
            `微信只有一个会话：「${binding.title}」。\n${shortId(binding.sessionId)}\n\n` +
            `已切回该会话。想清空历史：在桌面端删除「${binding.title}」，下次发消息会自动重建。`,
        }
      }

      case '/list': {
        /*
         * One list: every session on the machine, most recently talked to first, capped at
         * `limit` (default 10). `/list 10` therefore *is* the ten sessions last touched —
         * which is what "最近的 10 条" has to mean, or the command answers with fewer rows
         * than asked for whenever this chat's own index is small.
         *
         * Recency also fixes the older worry about other projects burying this chat's
         * conversations: a session just used is at the top regardless of which workspace
         * it belongs to, and the current one is marked with ← 当前.
         *
         * The rows shown are remembered, because a number the user replies to `/switch`
         * has to mean the row they saw — including the `/list 10` cut.
         */
        const { limit } = parseListArgs(args)
        const all = sortByRecent(await this.#gateway.listSessions())
        if (all.length === 0) return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
        const currentId = bindings[params.conversationId]?.sessionId
        this.#lastList.set(params.conversationId, all.slice(0, limit))
        return {
          kind: 'reply',
          text: renderSessionList(all, currentId, { limit }),
        }
      }

      case '/switch': {
        /*
         * Search every session, number only the ones the user was shown.
         *
         * The remembered `/list` rows (when any) *are* what the user was shown — including
         * their order and the `/list 10` cut — so a reply of "3" means the third line on
         * their screen. Without a listing, fall back to the default view: the machine's
         * sessions, most recent first.
         */
        const all = sortByRecent(await this.#gateway.listSessions())
        const remembered = this.#lastList.get(params.conversationId)
        const numbered = remembered ?? all.slice(0, DEFAULT_LIST_LIMIT)
        const target = resolveTarget(args, all, numbered)
        if (target === undefined) {
          return { kind: 'reply', text: '找不到这个对话。回复「列表」看清单，再回复数字。' }
        }
        await this.#gateway.ensureSession(target.sessionId, target.title)
        const binding: SessionBinding = {
          conversationId: params.conversationId,
          accountId: params.accountId,
          peerId: params.peerId,
          sessionId: target.sessionId,
          title: target.title || this.#titlePrefix,
          createdAt: bindings[params.conversationId]?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        }
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
      }

      case '/current': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' }
        return {
          kind: 'reply',
          text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}\n最后使用：${new Date(binding.lastUsedAt).toLocaleString('zh-CN')}`,
        }
      }

      case '/cancel': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话。' }
        await this.#gateway.cancel(binding.sessionId)
        return { kind: 'reply', text: '已请求中断当前任务。' }
      }

      default:
        return { kind: 'reply', text: `未知指令 ${command}。\n\n${HELP_TEXT}` }
    }
  }

  /** Create (or re-adopt) the binding to the one canonical WeChat session. */
  async #bind(params: { conversationId: string; accountId: string; peerId: string }): Promise<SessionBinding> {
    const bindings = await this.#load()
    const sessionId = CANONICAL_SESSION_ID
    const title = this.#titlePrefix
    await this.#gateway.ensureSession(sessionId, title)
    const now = Date.now()
    const existing = bindings[params.conversationId]
    const binding: SessionBinding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId,
      title,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    return binding
  }

  async #load(): Promise<Record<string, SessionBinding>> {
    this.#bindings ??= await this.#store.load()
    /*
     * Migrate pre-uniqueness bindings in place.
     *
     * Older builds minted a random logical id per binding (`session-<uuid>`, e.g. the
     * original `session-24f80d4a…`). `/switch` targets are always real `ses_…` ids and
     * the canonical id is skipped, so this re-points leftovers at 「MiMo微信」 without
     * ever undoing a deliberate switch.
     */
    let dirty = false
    for (const binding of Object.values(this.#bindings)) {
      if (binding.sessionId.startsWith('session-') && binding.sessionId !== CANONICAL_SESSION_ID) {
        binding.sessionId = CANONICAL_SESSION_ID
        binding.title = this.#titlePrefix
        dirty = true
      }
    }
    if (dirty) await this.#store.save(this.#bindings)
    return this.#bindings
  }
}

/** Commands that may be written with or without an argument. */
const COMMANDS_WITH_ARG = ['/switch', '/model', '/list'] as const

/** Commands that never take an argument. */
const COMMANDS_BARE = ['/help', '/list', '/current', '/cancel', '/mimowechat'] as const

/**
 * Split `/cmd args` into its parts.
 *
 * The separator space is optional, and `:` is accepted in its place, because these
 * commands are typed on a phone keyboard where a dropped space is the common case.
 * `/switch1`, `/switch 1`, and `/switch:1` all mean the same thing. A leading token
 * that only *starts* with a command name is left alone, so `/switchboard` is not `/switch`.
 */
export function splitCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  const space = trimmed.search(/\s/)
  if (space >= 0) {
    return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() }
  }

  const colon = lower.indexOf(':')
  if (colon > 0) {
    return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() }
  }

  if ((COMMANDS_BARE as readonly string[]).includes(lower)) {
    return { command: lower, args: '' }
  }

  for (const command of COMMANDS_WITH_ARG) {
    if (!lower.startsWith(command)) continue
    const rest = trimmed.slice(command.length)
    // A following ASCII letter means this was a different word, not this command
    // with a glued argument: `/switchboard` must not parse as `/switch` plus `board`.
    // Digits and non-ASCII text are legitimate glued arguments (`/switch1`, `/model中文`).
    if (/^[a-z]/.test(rest)) continue
    return { command, args: rest.replace(/^[:\s]+/, '').trim() }
  }

  return { command: lower, args: '' }
}

/**
 * Resolve a `/switch` argument against the session list.
 *
 * Accepts a 1-based list position, a full session id, the short id printed by
 * `/list`, or an exact title — a phone keyboard makes copying a full uuid painful.
 *
 * Matching is deliberately strict. Session ids share a common shape
 * (`session-<short>-<uuid>`), so a loose `includes` test can match several rows;
 * an ambiguous argument must fail rather than switch to a surprise session.
 *
 * @param args - What the user typed after `/switch`.
 * @param sessions - Every session that may be selected, usually the whole machine.
 * @param numbered - The rows a number refers to, when they differ from `sessions`.
 *
 *   This matters because the two are not the same list. A number is answered from the list the user
 *   was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 *   Without this, a session from another workspace was printed and then could not be selected.
 */
export function resolveTarget(
  args: string,
  sessions: readonly { sessionId: string; title: string; updatedAt: number }[],
  numbered: readonly { sessionId: string; title: string; updatedAt: number }[] = sessions,
): { sessionId: string; title: string } | undefined {
  const value = args.trim()
  if (!value) return undefined

  if (/^\d+$/.test(value)) {
    // A number refers to a row of the listing the user was shown, which is not necessarily the whole
    // machine — hence `numbered` rather than `sessions`.
    const byIndex = numbered[Number(value) - 1]
    if (byIndex !== undefined) return { sessionId: byIndex.sessionId, title: byIndex.title }

    /*
     * Out of range: only an exact title or the explicit short-id form may still answer.
     *
     * An id-suffix match must not — `/switch 3` after a `/list 2` used to fall through to
     * "the session whose id ends in 3" and silently moved the conversation to a row the user
     * had never been shown. A bare number the listing did not display has no other meaning,
     * so it fails, which is what lets the reply "3" mean exactly line 3 on the screen.
     */
    const byTitle = sessions.find((session) => session.title === value)
    if (byTitle !== undefined) return { sessionId: byTitle.sessionId, title: byTitle.title }
    const byShort = sessions.filter((session) => session.sessionId.startsWith(`session-${value}-`))
    if (byShort.length === 1) return { sessionId: byShort[0].sessionId, title: byShort[0].title }
    // An all-digit tail of a real `ses_…` id (what `/list` prints for desktop sessions).
    // Only for long enough values: "3" must stay a row number, never an id fragment.
    if (value.length >= 8) {
      const byTail = sessions.filter((session) => session.sessionId.endsWith(value))
      if (byTail.length === 1) return { sessionId: byTail[0].sessionId, title: byTail[0].title }
    }
    return undefined
  }

  const exactId = sessions.find((session) => session.sessionId === value)
  if (exactId !== undefined) return { sessionId: exactId.sessionId, title: exactId.title }

  // The short id lives in the middle: `session-<short>-<uuid>`.
  const byShort = sessions.filter((session) => session.sessionId.startsWith(`session-${value}-`))
  if (byShort.length === 1) return { sessionId: byShort[0].sessionId, title: byShort[0].title }

  const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value))
  if (bySuffix.length === 1) return { sessionId: bySuffix[0].sessionId, title: bySuffix[0].title }

  const byTitle = sessions.find((session) => session.title === value)
  if (byTitle !== undefined) return { sessionId: byTitle.sessionId, title: byTitle.title }

  /*
   * Last, a *core* title match in either direction — and only when exactly one session matches.
   *
   * People name a conversation the way they talk about it, in both directions of slop: they type a
   * fragment («北京»), or they add words of their own («北京今天天气如何**会话**»). Both are the same
   * request as the exact title, and exact matching alone failed on each — a hard failure for a
   * request the user can see is answerable.
   *
   * Uniqueness is the safeguard, and it is why this is the last resort. Several matches, or none,
   * return undefined: an ambiguous argument must fail rather than move the conversation somewhere the
   * user did not ask for. A word as short as a single character will usually match nothing here for
   * the same reason — good, because it would be a guess.
   */
  const core = (session: { title: string }): boolean =>
    session.title.includes(value) || value.includes(session.title)
  const byCore = sessions.filter((session) => session.title !== '' && core(session))
  if (byCore.length === 1) return { sessionId: byCore[0].sessionId, title: byCore[0].title }

  return undefined
}

/**
 * Recognise plain-language session control: a bare list number, a switch phrase with a
 * number/title target, or a request to see the conversation list.
 *
 * Returns the `/…` command for the router to run, or `undefined` for anything else.
 * Matching is deliberately narrow — "这个对话是什么" must still reach the agent —
 * but a bare number is unambiguous in this channel: `/list`'s footer tells the user
 * to reply with one, and without this hook that reply was sent to the agent as a
 * stray "3" and nothing switched.
 */
export function sessionIntent(
  text: string,
): { command: '/list' | '/switch'; args: string } | undefined {
  const raw = text.trim()
  // The number a listing asked for.
  if (/^\d{1,3}$/.test(raw)) return { command: '/switch', args: raw }

  const t = raw.replace(/[，。！？、\s「」『』]+/g, '')
  if (!t || t.length > 20) return undefined

  // 切换到3 / 换成第2个 / 切到5
  const num = /^(?:请|帮我|我想|我要)?(?:切换|换|切)(?:到|去|至|成)?(?:第)?(\d{1,3})(?:个|号|条)?$/.exec(t)
  if (num) return { command: '/switch', args: num[1] }

  // 切换到<标题> / 换到<标题> — everything after the verb is the title to resolve.
  // Two characters minimum: a lone trailing glyph ("换到头") is far more likely the
  // start of an ordinary sentence than a conversation title.
  const named = /^(?:切换|换|切)(?:到|去|至|成)(.+)$/.exec(t)
  if (named && !/(?:对话|会话)$/.test(named[1])) {
    const target = named[1].replace(/^第/, '').replace(/[个号条]$/, '')
    if (target.length >= 2) return { command: '/switch', args: target }
  }

  // 换个对话 / 切换会话（没有目标）→ 出列表让人挑
  if (/^(?:请|帮我|我想|我要)?(?:换|切换)(?:个|一下)?(?:对话|会话)$/.test(t)) {
    return { command: '/list', args: '' }
  }

  // 查看对话列表 / 看下有哪些对话 / 对话列表 …
  if (/^(?:对话|会话)列表$/.test(t)) return { command: '/list', args: '' }
  const wantsList =
    t.length <= 16 &&
    /(对话|会话)/.test(t) &&
    /^(?:查看|看|列出|显示|查询|给我|哪些|有什么|帮我看看?)/.test(t)
  if (wantsList) return { command: '/list', args: '' }

  return undefined
}

/**
 * Mint a session id in DSH's own format — kept for callers that need a one-off id.
 *
 * The id is `session-<uuid>` because the host treats that shape as its native
 * session identity. The trailing hex group is random; the leading group is
 * derived from it so that the compact form shown by `/list` is also the form
 * `/switch` accepts. WeChat itself uses `CANONICAL_SESSION_ID` instead: one
 * channel, one session.
 */
export function mintSessionId(random: () => string = randomUUID): string {
  const uuid = random()
  const tail = uuid.replace(/-/g, '').slice(0, 8)
  return `session-${tail}-${uuid}`
}

/** Compact identifier shown to the user, and accepted back by `/switch`. */
export function shortId(sessionId: string): string {
  const match = /^session-([0-9a-f]{8})-/i.exec(sessionId)
  if (match) return match[1]
  // Real `ses_…` ids: the first 8 chars are the shared `ses_` prefix plus a couple of
  // hex digits — every row would print the same thing. Take the tail instead, which is
  // unique and also what `resolveTarget`'s endsWith match accepts back.
  if (sessionId.startsWith('ses_')) return sessionId.slice(-8)
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

/** How many rows `/list` shows when no count is given. */
const DEFAULT_LIST_LIMIT = 10

/** Hard cap on `/list <N>`, so one command cannot dump the whole machine into a chat. */
const MAX_LIST_LIMIT = 50

/**
 * Parse a `/list` argument: optional `all`, optional row count, in either order.
 *
 * `all` is accepted for compatibility but no longer changes the scope — the list is
 * always machine-wide (see the `/list` case). Only the row count matters.
 * Anything unrecognised keeps the default for that slot.
 *
 * @param args - What the user typed after `/list`.
 * @returns Whether `all` was written (legacy), and how many rows to show.
 */
export function parseListArgs(args: string): { wantsAll: boolean; limit: number } {
  let wantsAll = false
  let limit = DEFAULT_LIST_LIMIT
  for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token === 'all') wantsAll = true
    else if (/^\d+$/.test(token)) limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(token)))
  }
  return { wantsAll, limit }
}

/** Newest first — the order a person means by "最近的". */
function sortByRecent(
  rows: { sessionId: string; title: string; updatedAt: number }[],
): { sessionId: string; title: string; updatedAt: number }[] {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Render one row of a session list.
 *
 * The title leads because it is what a person recognises. The short id follows on its own line,
 * because a workspace title is shared by every session in it, so two conversations in one workspace
 * are otherwise indistinguishable — and the id is what `/switch` accepts when a number is not enough.
 *
 * Shared by `/list` and by the tool's natural-language path, so the same request cannot produce two
 * different-looking answers depending on whether it was typed or spoken.
 *
 * @param session - Session to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @returns The row.
 */
export function renderSessionRow(
  session: { sessionId: string; title?: string; updatedAt?: number },
  index: number,
  currentId: string | undefined,
): string {
  const mark = session.sessionId === currentId ? '  ← 当前' : ''
  const title = (session.title ?? '').trim() || '(无标题)'
  const when = session.updatedAt === undefined ? '' : ` · ${relativeTime(session.updatedAt)}`
  return `${index + 1}. ${title}${mark}\n   ${shortId(session.sessionId)}${when}`
}

/**
 * Render the session list.
 *
 * @param sessions - Sessions to show, newest first.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param options - `held` is the sessions left out, so the message can say they exist and how to see
 * them. Naming them is the whole point: a user who is never told cannot ask.
 * `limit` is how many rows this listing asked for (see `parseListArgs`).
 * @returns The message body.
 */
export function renderSessionList(
  sessions: readonly { sessionId: string; title: string; updatedAt: number }[],
  currentId: string | undefined,
  options: {
    held?: readonly { sessionId: string; title: string; updatedAt: number }[]
    /** How to reach the held sessions. Typed and spoken requests need different wording. */
    heldHint?: string
    /** Max rows to print; defaults to the `/list` default count. */
    limit?: number
  } = {},
): string {
  const held = options.held ?? []
  const limit = options.limit ?? DEFAULT_LIST_LIMIT
  const shown = sessions.slice(0, limit)
  const lines = shown.map((session, index) => renderSessionRow(session, index, currentId))
  const more =
    sessions.length > shown.length ? `\n\n（还有 ${sessions.length - shown.length} 个更早的对话未显示）` : ''
  const elsewhere =
    held.length === 0
      ? ''
      : `\n\n另有 ${String(held.length)} 个对话在其它工作区，${options.heldHint ?? '一起看就发 /list all。'}`
  const all = sessions.length + held.length
  const header =
    shown.length >= sessions.length && held.length === 0
      ? `共 ${String(all)} 个对话：`
      : `最近对话（共 ${String(all)} 个，显示最近 ${String(shown.length)} 条，按最近对话排序）：`
  return [
    header,
    '',
    lines.join('\n\n'),
    more,
    elsewhere,
    '',
    '回复数字即可切换，例如「3」。',
  ].join('\n')
}

/**
 * How long ago something happened, in the words a person would use.
 *
 * Relative rather than absolute because the question the list answers is "which one was I just
 * working on", and a 24-hour clock makes that harder, not easier.
 *
 * @param at - Timestamp in milliseconds.
 * @param now - Current time, injectable for tests.
 * @returns A short phrase such as `3 分钟前`.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

export const HELP_TEXT = [
  '可用指令：',
  '/mimowechat     回到唯一会话「MiMo微信」（微信只有一个会话）',
  '/list [N|all]   列出最近对话（全机按最近对话排序，默认 10 条；/list 20 = 最近 20 条）',
  '/switch <编号>  切换到某个对话',
  '/current        显示当前对话',
  '/cancel         中断当前任务',
  '/model [名称]   查看或切换模型（d-smart 桌面 / a-pro API / a-flash …）',
  '/help           显示本帮助',
  '',
  '直接发消息即与当前对话对话。列表后回复数字即可切换。',
  '',
  '大白话同样有效：「查看对话列表」「换个对话」「切换到3」「用 2.5 pro」。',
].join('\n')
