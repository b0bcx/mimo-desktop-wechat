/**
 * MiMo Desktop / MiMoCode session gateway.
 *
 * Two backends, same shape as the router's `SessionGateway`:
 *
 * 1. **Plugin** — uses the `@mimo-ai/plugin` client when running inside MiMo Desktop.
 * 2. **CLI** — shells out to `mimo run` / `mimo session` when running standalone.
 *
 * The CLI path is what makes "锁屏出门也能用" work without a plugin install:
 * any process on the machine can drive the same agent the desktop is using.
 *
 * @module mimo-desktop-wechat/mimo-gateway
 */

import { spawn } from 'node:child_process'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { SessionGateway } from '../core/router.ts'
import { WECHAT_SESSION_TITLE } from '../core/router.ts'
import { isDesktopLane } from './models.ts'

const isWindows = process.platform === 'win32'

/**
 * Resolve the `mimo` launcher.
 *
 * On Windows `mimo` is a `.cmd` shim that merely calls `node …/bin/mimo`.
 * Spawning that shim through `cmd.exe /c` is fragile: argument boundaries and
 * non-ASCII text get mangled, which surfaces as yargs printing help (or as
 * `ENOENT` when we spawned the bare name). Prefer invoking `node` with the CLI
 * entry directly — same as the shim does, without the shell in the middle.
 */
export async function resolveMimoLaunch(
  preferred?: string,
): Promise<{ command: string; argsPrefix: string[] }> {
  const raw = preferred || process.env.MIMO_BIN || 'mimo'

  // Explicit path (MIMO_BIN or relative).
  if (raw.includes('\\') || raw.includes('/') || raw.includes('.')) {
    if (await exists(raw)) return await viaNodeIfScript(raw)
  }

  const candidates = isWindows
    ? [`${raw}.cmd`, `${raw}.exe`, raw, `${raw}.ps1`]
    : [raw]

  const pathDirs = (process.env.PATH || process.env.Path || '')
    .split(delimiter)
    .filter(Boolean)
  const extraDirs = [
    join(homedir(), 'AppData', 'Roaming', 'npm'),
    join(homedir(), '.npm-global', 'bin'),
  ]

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of candidates) {
      const full = join(dir, name)
      if (await exists(full)) return await viaNodeIfScript(full)
    }
  }

  // Last resort: bare name, shell-resolved.
  if (isWindows) {
    return { command: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', raw] }
  }
  return { command: raw, argsPrefix: [] }
}

/**
 * If `file` is an npm `.cmd` shim (or a JS entry), resolve to `node <entry>`.
 * `.exe` is passed through as-is.
 */
async function viaNodeIfScript(file: string): Promise<{ command: string; argsPrefix: string[] }> {
  const lower = file.toLowerCase()

  // Direct binary: use it.
  if (lower.endsWith('.exe') && !lower.endsWith('node.exe')) {
    return { command: file, argsPrefix: [] }
  }
  // Already a node invocation target (the bin/mimo script).
  if (lower.endsWith('mimo') && !lower.endsWith('.cmd') && !lower.endsWith('.ps1')) {
    // Heuristic: the npm bin file has no extension; treat as node entry if it exists as a file.
    if (await exists(file)) {
      const nodeBin = await findNodeNear(file)
      return { command: nodeBin, argsPrefix: [file] }
    }
  }

  if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) {
    // npm shim lives in a bin dir; the real entry is `<dir>/node_modules/@mimo-ai/cli/bin/mimo`.
    const dir = file.replace(/[\\/][^\\/]+$/, '')
    const entry = join(dir, 'node_modules', '@mimo-ai', 'cli', 'bin', 'mimo')
    if (await exists(entry)) {
      const nodeBin = await findNodeNear(file) || 'node'
      return { command: nodeBin, argsPrefix: [entry] }
    }
    // Shell out only as a fallback.
    if (lower.endsWith('.ps1')) {
      return {
        command: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      }
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', file],
    }
  }

  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    const nodeBin = await findNodeNear(file)
    return { command: nodeBin, argsPrefix: [file] }
  }

  // A plain path that exists but isn't recognized — try node next to it, else raw.
  const nodeBin = await findNodeNear(file)
  if (nodeBin && nodeBin !== 'node') return { command: nodeBin, argsPrefix: [file] }
  return { command: file, argsPrefix: [] }
}

/** Prefer the `node.exe` sitting beside an npm shim (nvm / portable layouts). */
async function findNodeNear(file: string): Promise<string> {
  let dir = file.replace(/[\\/][^\\/]+$/, '')
  for (let i = 0; i < 3 && dir; i++) {
    const candidates = isWindows
      ? [join(dir, 'node.exe'), join(dir, 'node')]
      : [join(dir, 'node')]
    for (const c of candidates) {
      if (await exists(c)) return c
    }
    const parent = dir.replace(/[\\/][^\\/]+$/, '')
    if (parent === dir) break
    dir = parent
  }
  return process.env.MIMO_NODE || 'node'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Where WeChat-bound sessions live. Mirrors dsh-wechat's `$DSH_HOME/dsh_wechat` convention. */
export function mimoWechatWorkspace(): string {
  const home = process.env.MIMO_WECHAT_HOME || join(homedir(), '.mimo-desktop-wechat')
  return join(home, 'workspace')
}

export function mimoStateDir(): string {
  return process.env.MIMO_WECHAT_HOME || join(homedir(), '.mimo-desktop-wechat')
}

/**
 * Drive MiMo via the `mimo` CLI.
 *
 * Prefer this when a plugin client is not available: it works with a locked screen,
 * survives desktop restarts, and needs no extra API surface.
 */
export class MimoCliGateway implements SessionGateway {
  readonly #mimoBin: string
  readonly #workspace: string
  /**
   * Model id passed as `mimo run -m`.
   * Empty string means "omit -m" (follow MiMoCode / desktop config default).
   * Mutable so WeChat `/model` can switch at runtime; persisted to disk.
   */
  #model: string
  readonly #modelFile: string
  /** sessionId → title, persisted so `/list` survives restarts without scanning the disk. */
  readonly #indexFile: string
  /** logical id → real `ses_…` id. `mimo run -s` rejects the router's minted ids. */
  readonly #aliasFile: string
  /** Resolved once, so every spawn uses the same Windows-safe launcher. */
  #launch: Promise<{ command: string; argsPrefix: string[] }> | undefined

  constructor(options: { mimoBin?: string; workspace?: string; model?: string } = {}) {
    this.#mimoBin = options.mimoBin || process.env.MIMO_BIN || 'mimo'
    this.#workspace = options.workspace || mimoWechatWorkspace()
    this.#modelFile = join(mimoStateDir(), 'current-model.txt')
    this.#model = ''
    this.#indexFile = join(mimoStateDir(), 'session-index.json')
    this.#aliasFile = join(mimoStateDir(), 'session-alias.json')
    this.#launch = resolveMimoLaunch(this.#mimoBin)
    // Priority: constructor > persisted /model choice > env > desktop-aligned default.
    const initial = options.model ?? ''
    void this.#loadModel(initial)
  }

  /** Current `-m` value; `''` = follow config default. */
  get model(): string {
    return this.#model
  }

  /** Switch model for subsequent prompts. Pass `''` to follow config default. */
  async setModel(id: string): Promise<void> {
    this.#model = id
    await mkdir(mimoStateDir(), { recursive: true })
    await writeFile(this.#modelFile, id, 'utf-8')
  }

  async #loadModel(constructorModel: string): Promise<void> {
    try {
      const saved = (await readFile(this.#modelFile, 'utf-8')).trim()
      if (saved !== '') this.#model = saved
    } catch {
      // no persisted choice yet
    }
    if (this.#model === '') {
      this.#model =
        constructorModel ||
        process.env.MIMO_MODEL ||
        'xiaomi/mimo-v2.6-flash'
    }
  }

  /** Awaited before the first prompt so /model state is loaded. */
  async #ready(): Promise<void> {
    // #loadModel is fire-and-forget in the constructor; this waits for it via microtask chain
    // by re-reading when still empty after a tick — cheap and race-free enough.
    if (this.#model !== '') return
    await new Promise((r) => setTimeout(r, 0))
    try {
      const saved = (await readFile(this.#modelFile, 'utf-8')).trim()
      if (saved !== '') this.#model = saved
    } catch {
      if (this.#model === '') this.#model = process.env.MIMO_MODEL || 'xiaomi/mimo-v2.6-flash'
    }
  }

  async ensureSession(sessionId: string, title: string): Promise<void> {
    await mkdir(this.#workspace, { recursive: true })
    await this.#touchIndex(sessionId, title)
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.promptAndCapture(sessionId, text)
  }

  /**
   * Run a prompt and capture the final assistant text.
   *
   * First turn for a logical id runs without `-s` and adopts the `ses_…` the
   * stream reports; later turns resume that real session. The router's minted
   * `session-<uuid>` ids are only aliases — passing them to `-s` yields
   * `Session not found` and an empty reply.
   */
  async promptAndCapture(logicalId: string, text: string, isRetry = false): Promise<string> {
    await this.#ready()
    await mkdir(this.#workspace, { recursive: true })
    await this.#touchIndex(logicalId, WECHAT_SESSION_TITLE)

    let realId = await this.#resolveRealSession(logicalId)
    if (!realId && !isRetry) {
      // The alias table can be empty while the session still exists (fresh state dir,
      // manual cleanup). WeChat has exactly one session — adopt it rather than minting
      // a second row with the same name.
      const existing = await this.#findCanonicalSession()
      if (existing) {
        await this.#setAlias(logicalId, existing)
        realId = existing
      }
    }
    const useDesktopEngine = isDesktopLane(this.#model)

    if (useDesktopEngine) {
      return await this.#promptViaDesktop(logicalId, realId, text, isRetry)
    }

    // API / default lane: local `mimo run`.
    const args = ['run', '--format', 'json', '--yolo']
    args.push('--dir', this.#workspace)
    if (this.#model) args.push('-m', this.#model)
    if (realId) {
      args.push('-s', realId)
    } else {
      args.push('--title', WECHAT_SESSION_TITLE)
    }
    args.push(text)

    const result = await runMimoCapture(this.#mimoBin, args)

    const created = extractSessionId(result.stdout)
    if (created) await this.#setAlias(logicalId, created)

    const reply = extractFinalText(result.stdout)
    if (reply) return reply

    // Stale alias (session deleted / expired): drop it and retry once — the retry
    // skips canonical adoption so a session the host rejects cannot loop.
    if (realId && !isRetry && /not found/i.test(result.stderr)) {
      await this.#setAlias(logicalId, '')
      return await this.promptAndCapture(logicalId, text, true)
    }

    if (result.stderr.trim() || (result.code !== 0 && !result.stdout.trim())) {
      const detail = (result.stderr.trim() || `exit ${result.code}`).split('\n').slice(0, 4).join(' | ')
      throw new Error(`mimo run 失败：${detail}`)
    }
    return '(无回复)'
  }

  /**
   * Desktop lane through MiMo Desktop's local control API (`desktop-api.json`).
   *
   * The engine's own HTTP surface is credential-closed — it generates a password kept
   * in memory, never printed or exported — so `mimo run --attach` can never authenticate.
   * The Desktop app separately serves a token-authenticated API on loopback (health,
   * sessions, messages, SSE events, `POST /v1/sessions/<id>/turns`); that is this path.
   *
   * A brand-new conversation has no engine-side session yet. A local `mimo run` registers
   * one even though the desktop-only model cannot resolve outside Desktop: the error
   * event still carries the minted `ses_…`, which is all we need before sending the real
   * turn through the API.
   */
  async #promptViaDesktop(
    logicalId: string,
    realId: string | undefined,
    text: string,
    isRetry = false,
  ): Promise<string> {
    const cred = await readDesktopApiCred()
    if (!cred) {
      throw new Error(
        `当前是【桌面端内置】模型 ${this.#model}，走 mimo-desktop SSO 链路，` +
          `需要 MiMo Desktop 在运行。请打开桌面端，或改用 API 链路：/model a-flash 或 /model a-pro`,
      )
    }

    let sid = realId
    if (!sid) {
      const mint = await runMimoCapture(
        this.#mimoBin,
        [
          'run', '--format', 'json', '--yolo',
          '--dir', this.#workspace,
          '-m', this.#model,
          '--title', WECHAT_SESSION_TITLE,
          text,
        ],
        { stopOnErrorWithSession: true },
      )
      sid = extractSessionId(mint.stdout)
      if (!sid) {
        const detail = (mint.stderr.trim() || mint.stdout.trim() || `exit ${mint.code}`)
          .split('\n').slice(0, 2).join(' | ')
        throw new Error(`桌面链路建会话失败：${detail}。可改用 API：/model a-flash`)
      }
      await this.#setAlias(logicalId, sid)
      const localReply = extractFinalText(mint.stdout)
      if (localReply) return localReply
    }

    try {
      return await desktopTurn(cred, sid, text, this.#model)
    } catch (error) {
      // The engine no longer knows this session (deleted / expired): drop the alias
      // and run once more, which re-mints a fresh session. The retry skips canonical
      // adoption so a rejected session cannot loop.
      if (realId && !isRetry && isStaleDesktopSession(error)) {
        await this.#setAlias(logicalId, '')
        return await this.promptAndCapture(logicalId, text, true)
      }
      throw error
    }
  }

  /**
   * The one existing session titled `MiMo微信`, newest first if duplicates somehow exist.
   *
   * Read from the live machine list, not our index — the index is our own bookkeeping
   * and can be empty right after a cleanup while the real session is still there.
   */
  async #findCanonicalSession(): Promise<string | undefined> {
    const live = await this.#fetchLiveSessions()
    const matches = live
      .filter((s) => s.title === WECHAT_SESSION_TITLE)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return matches[0]?.sessionId
  }

  /**
   * All sessions on this machine (desktop + WeChat + probes).
   * Backed by `mimo session list --format json`, not just our local index.
   */
  async listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    const live = await this.#fetchLiveSessions()
    if (live.length > 0) return live
    return await this.#readIndex()
  }

  /**
   * WeChat-bound sessions only — default `/list` view.
   * Maps our logical index ids through the alias table so they match live `ses_` rows.
   */
  async listOwnSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    const index = await this.#readIndex()
    const aliases = await this.#readAliases()
    const live = await this.#fetchLiveSessions()
    const byId = new Map(live.map((s) => [s.sessionId, s]))

    const out: { sessionId: string; title: string; updatedAt: number }[] = []
    const seen = new Set<string>()
    for (const entry of index) {
      const real =
        entry.sessionId.startsWith('ses_')
          ? entry.sessionId
          : aliases[entry.sessionId] || ''
      const hit = real ? byId.get(real) : undefined
      const row = {
        sessionId: real || entry.sessionId,
        title: entry.title || hit?.title || entry.sessionId,
        updatedAt: entry.updatedAt || hit?.updatedAt || Date.now(),
      }
      if (!seen.has(row.sessionId)) {
        seen.add(row.sessionId)
        out.push(row)
      }
    }
    // Title prefix fallback: sessions we created are titled "MiMo微信" (legacy: "微信 …").
    for (const s of live) {
      if ((s.title === WECHAT_SESSION_TITLE || s.title.startsWith('微信')) && !seen.has(s.sessionId)) {
        seen.add(s.sessionId)
        out.push(s)
      }
    }
    if (out.length > 0) return out
    return index
  }

  async #fetchLiveSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    try {
      const result = await runMimoCapture(this.#mimoBin, [
        'session',
        'list',
        '--format',
        'json',
        '-n',
        '100',
      ])
      if (!result.stdout.trim()) return []
      const rows = JSON.parse(result.stdout) as Array<{
        id?: string
        title?: string
        updated?: number
      }>
      if (!Array.isArray(rows)) return []
      return rows
        .filter((r) => typeof r.id === 'string' && r.id.startsWith('ses_'))
        .map((r) => ({
          sessionId: r.id as string,
          title: (r.title as string) || (r.id as string),
          updatedAt: typeof r.updated === 'number' ? r.updated : Date.now(),
        }))
    } catch {
      return []
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const marker = join(mimoStateDir(), 'cancel', sessionId)
    await mkdir(join(mimoStateDir(), 'cancel'), { recursive: true })
    await writeFile(marker, String(Date.now()), 'utf-8')
  }

  async #resolveRealSession(logicalId: string): Promise<string | undefined> {
    if (logicalId.startsWith('ses_')) return logicalId
    const aliases = await this.#readAliases()
    const real = aliases[logicalId]
    return real && real.startsWith('ses_') ? real : undefined
  }

  async #setAlias(logicalId: string, realId: string): Promise<void> {
    if (logicalId.startsWith('ses_')) return
    const aliases = await this.#readAliases()
    aliases[logicalId] = realId
    await mkdir(mimoStateDir(), { recursive: true })
    await writeFile(this.#aliasFile, JSON.stringify(aliases, null, 2), 'utf-8')
  }

  async #readAliases(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.#aliasFile, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  async #touchIndex(sessionId: string, title: string): Promise<void> {
    const all = await this.#readIndex()
    const found = all.find((s) => s.sessionId === sessionId)
    if (found) {
      found.updatedAt = Date.now()
      if (title && title !== found.title) found.title = title
    } else {
      all.unshift({ sessionId, title, updatedAt: Date.now() })
    }
    await mkdir(mimoStateDir(), { recursive: true })
    await writeFile(this.#indexFile, JSON.stringify(all, null, 2), 'utf-8')
  }

  async #readIndex(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    try {
      const raw = await readFile(this.#indexFile, 'utf-8')
      const parsed = JSON.parse(raw) as { sessionId: string; title: string; updatedAt: number }[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
}

/**
 * Pull the real MiMo session id (`ses_…`) out of an event stream.
 * Present on every event as a top-level `sessionID` (and often on `part` too).
 */
export function extractSessionId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const ev = JSON.parse(trimmed) as { sessionID?: unknown; part?: { sessionID?: unknown } }
      const id = ev.sessionID ?? ev.part?.sessionID
      if (typeof id === 'string' && id.startsWith('ses_')) return id
    } catch {
      // ignore
    }
  }
  return undefined
}

/**
 * Gateway backed by the `@mimo-ai/plugin` client.
 *
 * Used when the plugin is loaded inside MiMo Desktop: same conversation routing,
 * but prompts stay in-process and replies stream back through session hooks.
 */
type PluginClient = {
  session?: {
    create?: (body: unknown) => Promise<{ id?: string; sessionID?: string }>
    prompt?: (id: string, body: unknown) => Promise<unknown>
    list?: () => Promise<unknown>
    abort?: (id: string) => Promise<unknown>
  }
}

export class MimoPluginGateway implements SessionGateway {
  readonly #client: PluginClient
  readonly #workspace: string

  constructor(client: PluginClient, workspace?: string) {
    this.#client = client
    this.#workspace = workspace || mimoWechatWorkspace()
  }

  async ensureSession(sessionId: string, _title: string): Promise<void> {
    const s = this.#client.session
    if (!s?.create) return
    try {
      await s.create({ id: sessionId, directory: this.#workspace })
    } catch {
      // Adopting an existing session can throw on some hosts; the binding still holds.
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const s = this.#client.session
    if (!s?.prompt) throw new Error('MiMo client has no session.prompt')
    await s.prompt(sessionId, {
      parts: [{ type: 'text', text }],
    })
  }

  async listSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    const s = this.#client.session
    if (!s?.list) return []
    try {
      const raw = (await s.list()) as unknown
      return normalizeSessionList(raw)
    } catch {
      return []
    }
  }

  async listOwnSessions(): Promise<{ sessionId: string; title: string; updatedAt: number }[]> {
    return await this.listSessions()
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.#client.session
    if (!s?.abort) return
    try {
      await s.abort(sessionId)
    } catch {
      // best effort
    }
  }
}

function normalizeSessionList(raw: unknown): { sessionId: string; title: string; updatedAt: number }[] {
  const asArray = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown[] })?.data)
      ? (raw as { data: unknown[] }).data
      : Array.isArray((raw as { sessions?: unknown[] })?.sessions)
        ? (raw as { sessions: unknown[] }).sessions
        : []
  const out: { sessionId: string; title: string; updatedAt: number }[] = []
  for (const item of asArray) {
    const rec = item as Record<string, unknown>
    const id = (rec.id ?? rec.sessionID ?? rec.sessionId) as string | undefined
    if (typeof id !== 'string') continue
    const title =
      (typeof rec.title === 'string' && rec.title) ||
      (typeof rec.summary === 'string' && rec.summary) ||
      id.slice(0, 12)
    const time = rec.time as { updated?: number } | undefined
    const updatedAt =
      typeof rec.updatedAt === 'number'
        ? rec.updatedAt
        : typeof time?.updated === 'number'
          ? time.updated
          : Date.now()
    out.push({ sessionId: id, title, updatedAt })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export interface MimoRunResult {
  code: number
  stdout: string
  stderr: string
}

async function runMimo(bin: string, args: string[]): Promise<void> {
  await runMimoCapture(bin, args)
}

async function runMimoCapture(
  bin: string,
  args: string[],
  opts: { stopOnErrorWithSession?: boolean } = {},
): Promise<MimoRunResult> {
  const launch = await resolveMimoLaunch(bin)
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.argsPrefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      /*
       * Mint path: the desktop-only model always dies with an error event that still
       * carries the fresh `sessionID`. The process then lingers for a minute printing
       * its stack — we already have what we came for, so stop it now instead of making
       * the phone wait out that silence.
       */
      if (
        opts.stopOnErrorWithSession &&
        extractSessionId(stdout) &&
        /"type"\s*:\s*"error"/.test(stdout)
      ) {
        child.kill()
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error) => {
      reject(
        new Error(
          `无法启动 mimo（${launch.command}）：${error instanceof Error ? error.message : String(error)}。` +
            `请确认已安装 @mimo-ai/cli，或设置 MIMO_BIN 指向可执行文件。`,
        ),
      )
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

/** Credentials for MiMo Desktop's loopback control API, written while it runs. */
export interface DesktopApiCred {
  port: number
  token: string
}

/**
 * Read `%APPDATA%\Xiaomi MiMo\desktop-api.json`.
 *
 * Present only while the Desktop app is running (removed on quit), so this doubles
 * as the "is Desktop up" check. The token authenticates every route; never log it.
 */
export async function readDesktopApiCred(): Promise<DesktopApiCred | undefined> {
  const file = join(process.env.APPDATA || '', 'Xiaomi MiMo', 'desktop-api.json')
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as { port?: unknown; token?: unknown }
    if (typeof raw.port === 'number' && typeof raw.token === 'string' && raw.token !== '') {
      return { port: raw.port, token: raw.token }
    }
  } catch {
    // Desktop not running.
  }
  return undefined
}

/** Marker inside error text: the engine does not know this session any more. */
const DESKTOP_STALE_MARKER = 'desktop-session-stale'

function isStaleDesktopSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DESKTOP_STALE_MARKER)
}

const DESKTOP_TURN_TIMEOUT_MS = 10 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send one turn through the Desktop API and wait for the SSE `idle` that ends it.
 *
 * Event order that matters: subscribe first (the initial `idle` is ignored until the
 * POST lands), then `busy`, cumulative `text-partial`s, then a final `idle` — that last
 * one is the turn's completion signal. A session the engine does not know answers the
 * subscription with `closed` instead, which is detected before waiting for a reply
 * that will never come.
 */
async function desktopTurn(
  cred: DesktopApiCred,
  sessionId: string,
  message: string,
  model: string,
): Promise<string> {
  const base = `http://127.0.0.1:${cred.port}`
  const auth = { Authorization: `Bearer ${cred.token}` }
  const controller = new AbortController()

  let latestText = ''
  let uiText = ''
  let sawBusy = false
  let sawClosed = false
  let postOk = false
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let staleTimer: ReturnType<typeof setTimeout> | undefined

  let resolveDone!: (text: string) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<string>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const finish = (text: string): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearTimeout(staleTimer)
    controller.abort()
    resolveDone(text)
  }
  const fail = (error: Error): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearTimeout(staleTimer)
    controller.abort()
    rejectDone(error)
  }
  timer = setTimeout(
    () => fail(new Error('桌面端回复超时（10 分钟）。可改用 API 链路：/model a-flash')),
    DESKTOP_TURN_TIMEOUT_MS,
  )

  // Belt and braces for a silent drop: 202 but nothing ever happens.
  staleTimer = setTimeout(() => {
    if (finished || !postOk || sawBusy) return
    void (async () => {
      try {
        const res = await fetch(`${base}/v1/sessions/${sessionId}/messages`, { headers: auth })
        if (res.status === 404 && !sawBusy && !finished) {
          fail(new Error(`${DESKTOP_STALE_MARKER}：桌面端找不到会话（可能已删除）`))
        }
      } catch {
        // Network blip is not proof of staleness; the overall timeout still applies.
      }
    })()
  }, 20_000)

  void (async () => {
    try {
      const res = await fetch(`${base}/v1/sessions/${sessionId}/events`, {
        headers: auth,
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        fail(new Error(`桌面端事件流不可用（HTTP ${res.status}）。可改用 API 链路：/model a-flash`))
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]?.trim()
          const data = /^data: (.+)$/m.exec(block)?.[1]?.trim()
          if (!event || !data) continue
          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }
          if (event === 'busy') {
            sawBusy = true
          } else if (event === 'closed') {
            sawClosed = true
            if (postOk && !sawBusy) {
              fail(new Error(`${DESKTOP_STALE_MARKER}：桌面端已关闭该会话`))
            }
          } else if (event === 'text-partial') {
            if (typeof payload.text === 'string') latestText = payload.text
          } else if (event === 'ui') {
            const ui = payload.ui as { kind?: string; text?: string; partID?: string } | undefined
            if (ui?.kind === 'text' && typeof ui.text === 'string' && !ui.partID) uiText = ui.text
          } else if (event === 'idle') {
            if (postOk && sawBusy) finish(latestText || uiText || '(无回复)')
          }
        }
      }
      if (!finished) fail(new Error('桌面端事件流中断。可改用 API 链路：/model a-flash'))
    } catch (error) {
      if (!finished && !controller.signal.aborted) {
        fail(
          new Error(
            `桌面端事件流失败：${error instanceof Error ? error.message : String(error)}。` +
              `请确认 MiMo Desktop 在运行，或改用 API：/model a-flash`,
          ),
        )
      }
    }
  })()

  // POST after the subscription, so the final `idle` cannot be missed.
  try {
    let posted = false
    for (let attempt = 0; attempt < 5 && !posted && !finished; attempt++) {
      const res = await fetch(`${base}/v1/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model }),
      })
      if (res.status === 202) {
        posted = true
        postOk = true
        if (sawClosed && !sawBusy) {
          fail(new Error(`${DESKTOP_STALE_MARKER}：桌面端不认识该会话`))
        }
        break
      }
      const bodyText = await res.text().catch(() => '')
      if (res.status === 409) {
        await sleep(2000)
        continue
      }
      fail(
        new Error(
          `桌面端接收消息失败（HTTP ${res.status} ${bodyText.slice(0, 160)}）。` +
            `可改用 API 链路：/model a-flash`,
        ),
      )
      break
    }
    if (!posted && !finished) {
      fail(
        new Error(
          '桌面端会话正忙，重试未通过。稍后再发，或 /model a-flash 改用 API 链路。',
        ),
      )
    }
  } catch (error) {
    fail(
      new Error(
        `连接桌面端失败：${error instanceof Error ? error.message : String(error)}。` +
          `请确认 MiMo Desktop 在运行，或改用 API：/model a-flash`,
      ),
    )
  }

  return await done
}

/**
 * Pull the last assistant text out of `mimo run --format json` output.
/**
 * Pull the final assistant text out of `mimo run --format json` output.
 *
 * Real event shape (NDJSON, one event per line):
 *
 * ```json
 * {"type":"text","sessionID":"…","part":{"type":"text","text":"收到","messageID":"msg_…"}}
 * {"type":"step_finish","sessionID":"…","part":{"type":"step-finish", …}}
 * ```
 *
 * Text lives on `part.text`, not at the top level. Several `text` events may
 * share one `messageID` (streaming); they are concatenated in arrival order.
 * The last message's text is what the phone should see.
 */
export function extractFinalText(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  /** messageID → accumulated text, in arrival order. */
  const byMessage = new Map<string, { order: number; text: string }>()
  let order = 0
  let lastTopLevel = ''

  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      const ev = JSON.parse(line) as Record<string, unknown>
      const part = (ev.part ?? {}) as Record<string, unknown>
      const messageID =
        (typeof part.messageID === 'string' && part.messageID) ||
        (typeof ev.messageID === 'string' && ev.messageID) ||
        `__row_${order}`

      const isTextEvent =
        ev.type === 'text' || part.type === 'text' || typeof part.text === 'string'
      if (isTextEvent && typeof part.text === 'string' && part.text.trim()) {
        const existing = byMessage.get(messageID)
        if (existing) {
          // Streaming: later events may repeat a prefix. Prefer the longer cumulative body.
          if (part.text.startsWith(existing.text)) existing.text = part.text
          else if (!existing.text.includes(part.text)) existing.text += part.text
        } else {
          byMessage.set(messageID, { order: order++, text: part.text })
        }
      }

      // Fallback shapes some hosts use.
      const top =
        (typeof ev.text === 'string' && ev.text) ||
        (typeof ev.content === 'string' && ev.content) ||
        ''
      if (top.trim()) lastTopLevel = top

      if (Array.isArray(ev.parts)) {
        for (const raw of ev.parts) {
          const p = raw as Record<string, unknown>
          if (typeof p.text === 'string' && p.text.trim() && p.type !== 'reasoning') {
            lastTopLevel = p.text
          }
        }
      }
    } catch {
      // non-JSON noise; ignore
    }
  }

  if (byMessage.size > 0) {
    const last = [...byMessage.values()].sort((a, b) => a.order - b.order).at(-1)
    if (last?.text.trim()) return last.text.trim()
  }
  return lastTopLevel
}

/** List the sessions we have bound, used by diagnostics. */
export async function listWorkspaceFiles(): Promise<string[]> {
  const ws = mimoWechatWorkspace()
  try {
    return await readdir(ws)
  } catch {
    return []
  }
}
