/**
 * Standalone CLI: login / run / notify / status.
 *
 * This is the "不用装插件也能用" path: a Node process that speaks iLink to WeChat
 * and shells out to `mimo run` for the agent. Same experience as the plugin,
 * zero MiMo Desktop install steps.
 *
 *   npx mimo-desktop-wechat login
 *   npx mimo-desktop-wechat run
 *   npx mimo-desktop-wechat notify "构建完成了"
 *   npx mimo-desktop-wechat status
 */

import { createInterface } from 'node:readline/promises'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import QRCode from 'qrcode'

import { login, type LoginEvent } from '../core/login.ts'
import { mimoStateDir, MimoCliGateway, extractFinalText } from '../plugin/mimo-gateway.ts'
import { WechatMimoBridge, drainNotifyFiles } from '../plugin/bridge.ts'
import { loadAccount, saveAccount, clearAccount, accountFile } from '../plugin/account.ts'

const USAGE = `
mimo-desktop-wechat — 手机微信遥控本机 MiMo Desktop / MiMoCode

用法：
  mimo-desktop-wechat login              扫码绑定微信（只需一次）
  mimo-desktop-wechat run                启动微信 ↔ MiMo 桥（保持运行）
  mimo-desktop-wechat notify <文字>       主动推送一条微信消息
  mimo-desktop-wechat status             查看绑定与通道状态
  mimo-desktop-wechat logout             解除绑定

环境变量：
  MIMO_BIN            mimo 可执行文件（默认 PATH 里的 mimo）
  MIMO_WECHAT_HOME    状态目录（默认 ~/.mimo-desktop-wechat）
`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'login':
      return await cmdLogin()
    case 'run':
      return await cmdRun()
    case 'notify':
      return await cmdNotify(rest.join(' ').trim())
    case 'status':
      return await cmdStatus()
    case 'logout':
      await clearAccount()
      console.log('已解除绑定。')
      return
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE.trim())
      return
    default:
      console.error(`未知命令：${cmd}\n`)
      console.log(USAGE.trim())
      process.exitCode = 1
  }
}

async function cmdLogin(): Promise<void> {
  const existing = await loadAccount()
  if (existing) {
    console.log(`已有绑定：${existing.accountId}`)
    console.log('若要换账号，请先执行 logout。')
    return
  }

  console.log('正在获取二维码…')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ac = new AbortController()

  try {
    const events = login({}, ac.signal)
    for await (const event of events) {
      switch (event.kind) {
        case 'qr':
          await showQr(event.qrUrl)
          console.log('\n请用手机微信扫码，并在手机上确认登录。')
          break
        case 'scanned':
          console.log('已扫码，等待手机确认…')
          break
        case 'verifycode-required': {
          const code = await rl.question(`请输入手机上的验证码（第 ${event.attempt} 次）：`)
          const sent = await events.next(code)
          void sent
          break
        }
        case 'redirected':
          console.log(`已切换到节点：${event.host}`)
          break
        case 'expired':
          console.log(event.willRetry ? '二维码过期，正在刷新…' : '二维码反复过期，请重试。')
          break
        case 'confirmed':
          await saveAccount(event.account)
          console.log(`\n绑定成功：${event.account.accountId}`)
          console.log(`用户：${event.account.userId ?? '(未知)'}`)
          console.log('现在可以运行 `mimo-desktop-wechat run` 启动通道。')
          return
        case 'already-bound':
          console.log('该账号已绑定，无需重新扫码。')
          return
        case 'failed':
          console.error(`登录失败：${event.reason}`)
          process.exitCode = 1
          return
      }
    }
  } finally {
    rl.close()
    ac.abort()
  }
}

async function showQr(url: string): Promise<void> {
  try {
    const terminal = await QRCode.toString(url, { type: 'terminal', small: true })
    console.log(terminal)
  } catch {
    console.log(`扫码链接：${url}`)
  }
  // Also drop a PNG next to the state dir so the desktop UI can show it later.
  try {
    const dir = join(mimoStateDir(), 'wechat')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'last-qr.txt'), url, 'utf-8')
    const toFile = (QRCode as unknown as {
      toFile: (path: string, text: string, options?: { width?: number }) => Promise<void>
    }).toFile
    if (typeof toFile === 'function') {
      await toFile(join(dir, 'last-qr.png'), url, { width: 320 })
    }
  } catch {
    // best effort
  }
}

async function cmdRun(): Promise<void> {
  const account = await loadAccount()
  if (!account) {
    console.error('尚未登录。先运行：mimo-desktop-wechat login')
    process.exitCode = 1
    return
  }

  const gateway = new MimoCliGateway()
  const bridge = new WechatMimoBridge({
    account,
    gateway,
    onLog: (line) => console.log(`[mimo-wechat] ${line}`),
  })

  console.log('微信通道已启动。手机发消息即可对话；/help 查看指令。')
  console.log('Ctrl+C 退出。')

  // Drain any notify files the CLI collected while the bridge was down.
  const queued = await drainNotifyFiles()
  for (const item of queued) {
    await bridge.notify({ text: item.text, ...(item.conversationId === undefined ? {} : { conversationId: item.conversationId }) })
  }

  const stop = async (): Promise<void> => {
    console.log('\n正在停止…')
    await bridge.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())

  await bridge.start()
}

async function cmdNotify(text: string): Promise<void> {
  if (!text) {
    console.error('用法：mimo-desktop-wechat notify <文字>')
    process.exitCode = 1
    return
  }
  const account = await loadAccount()
  if (!account) {
    console.error('尚未登录。先运行：mimo-desktop-wechat login')
    process.exitCode = 1
    return
  }

  // If a `run` process is already up, leave a file for it; otherwise send directly.
  const lock = join(mimoStateDir(), 'run.pid')
  let running = false
  try {
    const pid = Number(await readFile(lock, 'utf-8'))
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, 0)
      running = true
    }
  } catch {
    running = false
  }

  if (running) {
    await mkdir(join(mimoStateDir(), 'notify'), { recursive: true })
    await writeFile(
      join(mimoStateDir(), 'notify', `${Date.now()}.json`),
      JSON.stringify({ text, queuedAt: Date.now() }),
      'utf-8',
    )
    console.log('已排队，正在运行的通道会立刻发出。')
    return
  }

  const gateway = new MimoCliGateway()
  const bridge = new WechatMimoBridge({ account, gateway })
  const result = await bridge.notify({ text })
  console.log(result.delivered ? '已发送到微信。' : result.queued ? '已排队（会话窗口关闭时会补发）。' : '发送失败：还没有绑定的对话。')
  await bridge.stop()
}

async function cmdStatus(): Promise<void> {
  const account = await loadAccount()
  console.log('状态目录：', mimoStateDir())
  console.log('凭证文件：', accountFile())
  if (!account) {
    console.log('微信绑定：未绑定')
    console.log('执行 `mimo-desktop-wechat login` 开始。')
    return
  }
  console.log('微信绑定：已绑定')
  console.log('  accountId：', account.accountId)
  console.log('  userId：', account.userId ?? '(未知)')
  console.log('  baseUrl：', account.baseUrl)
  console.log('  savedAt：', account.savedAt ?? '(未知)')
  console.log('  mimo bin：', process.env.MIMO_BIN || 'mimo')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})

// Re-export helpers so `node dist/cli/index.js` is also a small library.
export { extractFinalText }
