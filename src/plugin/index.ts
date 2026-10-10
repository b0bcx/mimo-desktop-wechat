/**
 * MiMo Desktop plugin entry: `mimo-desktop-wechat-plugin`.
 *
 * Load with `mimo plugin mimo-desktop-wechat` (or add to `mimocode.json`
 * `plugin: ["mimo-desktop-wechat"]`). Once loaded it:
 *
 * - starts the WeChat iLink long-poll in the background
 * - routes inbound WeChat messages to MiMo sessions (`/mimowechat` `/list` `/switch` …)
 * - registers `send_to_wechat` so the agent can push files/text to your phone
 * - on `session.post`, proactively notifies WeChat when a task finishes
 * - on `permission.ask`, can forward the prompt to WeChat for a numeric answer
 *
 * @module mimo-desktop-wechat/plugin
 */

import { tool } from '@mimo-ai/plugin/tool'

import type { Plugin, PluginInput, PluginOptions } from '@mimo-ai/plugin'
import { WechatMimoBridge } from './bridge.ts'
import { MimoPluginGateway, mimoStateDir } from './mimo-gateway.ts'
import { loadAccount, saveAccount } from './account.ts'

export const PLUGIN_ID = 'mimo-desktop-wechat-plugin'

type Client = PluginInput['client']

const MimoWechatPlugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const log = (line: string): void => {
    console.log(`[${PLUGIN_ID}] ${line}`)
  }

  let bridge: WechatMimoBridge | undefined
  let enabled = options?.enabled !== false

  const startBridge = async (): Promise<void> => {
    if (!enabled) return
    if (bridge) return
    const account = await loadAccount()
    if (!account) {
      log('尚未登录微信。运行 `npx mimo-desktop-wechat login` 扫码绑定。')
      return
    }
    const gateway = new MimoPluginGateway(input.client as never)
    bridge = new WechatMimoBridge({
      account,
      gateway,
      onLog: log,
    })
    void bridge.start().catch((error) => {
      log(`bridge stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
    log(`channel up → ${account.accountId}`)
  }

  // Best-effort start; a missing account is not a fatal plugin error.
  void startBridge()

  return {
    tool: {
      /**
       * Agent tool: push a message (and optional file) to the user's WeChat.
       * This is how a session that is *not* the WeChat-bound one can still
       * report "做完了" while the user is away from the desk.
       */
      send_to_wechat: tool({
        description:
          '主动把一段文字（可选附带本机文件路径）推送到用户的微信。' +
          '当任务完成、需要用户确认、或用户不在电脑前时使用。' +
          '手机上会收到消息；文件会作为附件发出。',
        args: {
          text: tool.schema.string().describe('要发送给用户微信的文字内容'),
          path: tool.schema
            .string()
            .optional()
            .describe('可选：本机文件绝对路径，将作为附件发送'),
          conversationId: tool.schema
            .string()
            .optional()
            .describe('可选：目标对话 id；默认发给最近使用的微信对话'),
        },
        async execute(args) {
          if (!bridge) {
            await startBridge()
          }
          if (!bridge) {
            return '微信通道未就绪：请先运行 npx mimo-desktop-wechat login 完成扫码绑定。'
          }
          const result = await bridge.notify({
            text: args.text,
            ...(args.path === undefined ? {} : { path: args.path }),
            ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
          })
          return result.delivered
            ? '已通过微信推送给用户。'
            : result.queued
              ? '当前微信会话窗口已关闭，消息已排队，用户下次发消息时会补发。'
              : '推送失败：还没有绑定的微信对话，请用户先在微信里给机器人发一条消息。'
        },
      }),
    },

    /**
     * When any session finishes, push a short summary to WeChat.
     * This is the "还会主动联系你" half of the product.
     */
    'session.post': async (input, _output) => {
      if (!bridge) return
      const text = (input.finalText || '').trim()
      if (!text) return
      const preview = text.length > 500 ? `${text.slice(0, 500)}\n…` : text
      await bridge.notify({
        text: `[会话完成] ${preview}`,
        conversationId: undefined,
      })
    },

    /**
     * Permission prompts can be answered from the phone.
     * We post the question; the user's numeric reply is handled by the
     * conversation router's plain-language path on the next inbound message.
     */
    'permission.ask': async (input, output) => {
      if (!bridge) return
      const title = (input as { title?: string; description?: string }).title ||
        (input as { metadata?: { title?: string } }).metadata?.title ||
        '权限申请'
      const message = (input as { message?: string; description?: string }).message ||
        (input as { description?: string }).description ||
        ''
      await bridge.notify({
        text: `【需要确认】${title}\n${message}\n\n回复「允许」或「拒绝」。`,
      })
      // Leave the decision to the default/desktop path unless the user is away;
      // a full numeric-answer loop is wired through the next inbound message.
      output.status = 'ask'
    },
  }
}

export default MimoWechatPlugin
export { MimoWechatPlugin }
export { loadAccount, saveAccount, type StoredAccount } from './account.ts'
export { WechatMimoBridge } from './bridge.ts'
export { mimoStateDir, MimoCliGateway, MimoPluginGateway } from './mimo-gateway.ts'
export { MODEL_CATALOG, resolveModelQuery, renderModelList, describeCurrentModel, isDesktopLane, LANE_LABEL } from './models.ts'
export type { ModelChoice, ModelLane } from './models.ts'
