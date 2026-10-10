/**
 * 最小示例：只用微信回声，不接 MiMo。
 * 用来验证 iLink 登录 + 长轮询 + 发送是否通。
 *
 *   npx tsx examples/echo-bot.ts
 */

import { login } from '../src/core/login.ts'
import { ChannelMonitor, sendText } from '../src/core/channel.ts'
import { loadAccount, saveAccount } from '../src/plugin/account.ts'

async function main(): Promise<void> {
  let account = await loadAccount()
  if (!account) {
    console.log('请先扫码…')
    for await (const event of login({})) {
      if (event.kind === 'qr') console.log('二维码：', event.qrUrl)
      if (event.kind === 'confirmed') {
        account = event.account
        await saveAccount(account)
        console.log('绑定成功', account.accountId)
        break
      }
      if (event.kind === 'failed') throw new Error(event.reason)
    }
    if (!account) return
  }

  const monitor = new ChannelMonitor({
    account,
    onMessage: async (msg) => {
      console.log('收到：', msg.text)
      await sendText({
        account: account!,
        to: msg.peerId,
        text: `回声：${msg.text}`,
        ...(msg.contextToken === undefined ? {} : { contextToken: msg.contextToken }),
      })
    },
    onError: (e) => console.error(e),
  })

  await monitor.run(new AbortController().signal)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
