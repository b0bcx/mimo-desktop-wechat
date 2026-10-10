/**
 * Model catalog for WeChat `/model`.
 *
 * Three groups:
 *
 * 1. **桌面端内置** — `mimo-desktop/*` (SSO lane; Smart / Flash / Pro)
 * 2. **自定义供应商** — read live from `mimocode.jsonc` `provider` section
 *    (小米 API is just one of them; a6api / any other configured provider shows up too)
 * 3. **跟随配置** — omit `-m`
 *
 * The catalog is rebuilt on each `/model` so adding a provider in Desktop
 * settings does not require restarting the WeChat bridge.
 *
 * @module mimo-desktop-wechat/models
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

export type ModelLane = 'desktop' | 'custom' | 'default'

export interface ModelChoice {
  key: string
  label: string
  lane: ModelLane
  aliases: string[]
  /** Full `provider/model` id, or empty for config default. */
  id: string
  hint: string
  /** Provider id for grouping (`mimo-desktop`, `xiaomi`, …). */
  provider?: string
}

export const LANE_LABEL: Record<ModelLane, string> = {
  desktop: '桌面端内置（mimo-desktop SSO）',
  custom: '自定义供应商（读自 mimocode 配置）',
  default: '跟随配置',
}

/** One model from a configured provider. */
interface ConfigModel {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
}

function stripJsonc(text: string): string {
  // Remove // line comments and /* */ block comments outside strings (good enough for our config).
  let out = ''
  let inStr = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function parseConfigJsonc(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stripJsonc(text)) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Candidate config paths: global, then nearby project roots. */
function configCandidates(): string[] {
  const home = homedir()
  const list = [
    join(home, '.config', 'mimocode', 'mimocode.jsonc'),
    join(home, '.config', 'mimocode', 'mimocode.json'),
    join(home, '.mimocode', 'mimocode.jsonc'),
    join(home, '.mimocode', 'mimocode.json'),
  ]
  // Workspace / project overrides (walk a few parents from cwd).
  let dir = process.cwd()
  for (let n = 0; n < 5; n++) {
    list.push(
      join(dir, '.mimocode', 'mimocode.jsonc'),
      join(dir, '.mimocode', 'mimocode.json'),
      join(dir, 'mimocode.jsonc'),
      join(dir, 'mimocode.json'),
    )
    const parent = pathResolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return list
}

/**
 * Read every configured provider/model from mimocode config files.
 * Later files override earlier for the same `provider/model`.
 * Never exposes `apiKey`.
 */
export async function loadConfiguredModels(): Promise<ConfigModel[]> {
  const byId = new Map<string, ConfigModel>()
  for (const file of configCandidates()) {
    let text: string
    try {
      text = await readFile(file, 'utf-8')
    } catch {
      continue
    }
    const cfg = parseConfigJsonc(text)
    const providers = cfg?.provider
    if (!providers || typeof providers !== 'object') continue
    for (const [providerId, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as {
        name?: unknown
        models?: unknown
      }
      const providerName =
        (typeof p.name === 'string' && p.name.trim()) || providerId
      const models = p.models
      if (!models || typeof models !== 'object') continue
      for (const modelId of Object.keys(models as Record<string, unknown>)) {
        const spec = (models as Record<string, unknown>)[modelId]
        let modelName = modelId
        if (spec && typeof spec === 'object') {
          const n = (spec as { name?: unknown }).name
          if (typeof n === 'string' && n.trim()) modelName = n
        }
        byId.set(`${providerId}/${modelId}`, {
          providerId,
          providerName,
          modelId,
          modelName,
        })
      }
    }
  }
  return [...byId.values()]
}

function aliasKey(providerId: string, modelId: string): string {
  // Short key: prefer model id; disambiguate across providers.
  return `${providerId}/${modelId}`
}

/**
 * Rebuild the full catalog (desktop lane + every configured provider + default).
 * Call on each `/model` so Desktop settings changes appear immediately.
 */
export async function buildModelCatalog(): Promise<ModelChoice[]> {
  const desktop: ModelChoice[] = [
    {
      key: 'd-smart',
      label: '桌面 · Smart 智能路由',
      lane: 'desktop',
      aliases: ['d-smart', 'smart', '智能', '桌面smart', 'desktop-smart'],
      id: 'mimo-desktop/mimo-auto',
      hint: '桌面端内置 smart-router（SSO）',
      provider: 'mimo-desktop',
    },
    {
      key: 'd-flash',
      label: '桌面 · 2.6 Flash',
      lane: 'desktop',
      aliases: ['d-flash', '桌面flash', 'desktop-flash'],
      id: 'mimo-desktop/mimo-v2.6-flash',
      hint: '桌面 SSO 链路，不是配置里的 API',
      provider: 'mimo-desktop',
    },
    {
      key: 'd-pro',
      label: '桌面 · 2.6 Pro',
      lane: 'desktop',
      aliases: ['d-pro', '桌面pro', 'desktop-pro'],
      id: 'mimo-desktop/mimo-v2.6-pro',
      hint: '桌面 SSO 链路，不是配置里的 API',
      provider: 'mimo-desktop',
    },
  ]

  const configured = await loadConfiguredModels()
  const custom: ModelChoice[] = configured.map((m) => {
    const full = `${m.providerId}/${m.modelId}`
    const aliases = [
      full,
      m.modelId,
      aliasKey(m.providerId, m.modelId),
      // Bare aliases only when unique later — keep simple: model id + full id
    ]
    return {
      key: full.replace(/\//g, ':'),
      label: `${m.providerName} · ${m.modelName}`,
      lane: 'custom',
      aliases: aliases.filter((a, i, arr) => arr.indexOf(a) === i),
      id: full,
      hint: `供应商 ${m.providerId}`,
      provider: m.providerId,
    } satisfies ModelChoice
  })

  const def: ModelChoice = {
    key: 'default',
    label: '跟随配置',
    lane: 'default',
    aliases: ['default', '默认', '配置', 'config'],
    id: '',
    hint: '不传 -m，用宿主默认',
    provider: '',
  }

  return [...desktop, ...custom, def]
}

/** Resolve `/model <query>` against a freshly built catalog. */
export async function resolveModelQueryAsync(query: string): Promise<ModelChoice | undefined> {
  const catalog = await buildModelCatalog()
  return resolveAgainst(catalog, query)
}

export function resolveAgainst(catalog: readonly ModelChoice[], query: string): ModelChoice | undefined {
  const raw = query.trim()
  if (!raw) return undefined
  const q = raw.toLowerCase().replace(/\s+/g, '')

  // Full provider/model
  if (raw.includes('/')) {
    const exact = catalog.find((m) => m.id === raw)
    if (exact) return exact
    if (raw.startsWith('mimo-desktop/')) {
      const known = catalog.find((m) => m.id === raw)
      if (known) return known
      return {
        key: raw.replace(/\//g, ':'),
        label: `桌面 · ${raw.slice('mimo-desktop/'.length)}`,
        lane: 'desktop',
        aliases: [],
        id: raw,
        hint: '桌面 SSO 模型 id',
        provider: 'mimo-desktop',
      }
    }
    return {
      key: raw.replace(/\//g, ':'),
      label: raw,
      lane: 'custom',
      aliases: [],
      id: raw,
      hint: '自定义 provider/model',
      provider: raw.split('/')[0],
    }
  }

  // Exact key / alias / model id
  for (const m of catalog) {
    if (m.key === q || m.id.toLowerCase() === q) return m
    if (m.aliases.some((a) => a.toLowerCase() === q)) return m
  }
  // model id only (e.g. `gpt-6-astra`, `mimo-v2.6-pro`) — first match wins
  for (const m of catalog) {
    const mid = m.id.split('/').pop() || ''
    if (mid.toLowerCase() === q) return m
  }
  // Soft contains
  for (const m of catalog) {
    if (m.aliases.some((a) => a.toLowerCase().includes(q)) || m.id.toLowerCase().includes(q)) {
      return m
    }
  }
  return undefined
}

export function renderModelListFrom(catalog: readonly ModelChoice[], currentId: string): string {
  const lines: string[] = []
  let lastLane: ModelLane | undefined
  let lastProvider: string | undefined
  const counts: Record<ModelLane, number> = { desktop: 0, custom: 0, default: 0 }
  for (const m of catalog) counts[m.lane]++
  for (const m of catalog) {
    if (m.lane !== lastLane) {
      lines.push('')
      lines.push(`【${LANE_LABEL[m.lane]}】`)
      lastLane = m.lane
      lastProvider = undefined
    }
    if (m.lane === 'custom' && m.provider !== lastProvider) {
      lines.push(`  供应商 ${m.provider}:`)
      lastProvider = m.provider
    }
    const mark = currentId === m.id ? '  ← 当前' : ''
    const indent = m.lane === 'custom' ? '    ' : '· '
    lines.push(`${indent}${m.id || '(默认)'} — ${m.label}${mark}`)
  }

  // Per-provider tally: lets the reader check the list against their own config file
  // at a glance ("配置 8" = what mimocode.jsonc actually declares), instead of
  // wondering where the extra rows came from.
  const byProvider = new Map<string, number>()
  for (const m of catalog) {
    if (m.lane !== 'custom' || !m.provider) continue
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1)
  }
  const providersLine =
    byProvider.size === 0
      ? ''
      : `配置明细：${[...byProvider].map(([p, n]) => `${p} ${n}`).join(' · ')}`

  return [
    `模型列表 · 桌面内置 ${counts.desktop} + 配置 ${counts.custom} + 跟随配置 ${counts.default}（共 ${catalog.length}）：`,
    ...lines,
    ...(providersLine ? ['', providersLine] : []),
    '',
    '用法：/model <完整 id>   如 /model a6api-com/glm-5.3、/model d-pro、/model mimo-v2.6-pro',
    '/model              查看当前',
    '',
    '说明：桌面内置走 mimo-desktop SSO；',
    '     配置部分逐条读自 mimocode.jsonc 的 provider（上面的明细就是文件里的内容），',
    '     不多不少——没在这里的模型就是没配置。',
  ].join('\n')
}

/** Async wrapper that builds catalog then renders. */
export async function renderModelList(currentId: string): Promise<string> {
  return renderModelListFrom(await buildModelCatalog(), currentId)
}

export async function describeCurrentModel(currentId: string): Promise<string> {
  const catalog = await buildModelCatalog()
  const found = catalog.find((m) => m.id === currentId && m.id !== '')
  if (found) {
    return `${found.label}\n链路：${LANE_LABEL[found.lane]}\n${found.id}`
  }
  if (!currentId) return '跟随配置（默认）'
  return currentId
}

export function isDesktopLane(id: string): boolean {
  return id.startsWith('mimo-desktop/')
}

/**
 * Kept for older imports — builds once. Prefer `buildModelCatalog()` + `resolveAgainst`.
 * Desktop lane is static; custom lane is filled from config when this runs.
 */
export async function getModelCatalog(): Promise<readonly ModelChoice[]> {
  return buildModelCatalog()
}

/** @deprecated use resolveModelQueryAsync */
export async function resolveModelQuery(query: string): Promise<ModelChoice | undefined> {
  return resolveModelQueryAsync(query)
}

// Sync stub so existing `resolveModelQuery` call sites that forgot await still typecheck
// — actually bridge already awaits? We'll update bridge to await.
export { resolveAgainst as resolveModelQuerySync }

// Legacy static export filled lazily for any sync readers.
export const MODEL_CATALOG: readonly ModelChoice[] = [
  {
    key: 'd-smart',
    label: '桌面 · Smart',
    lane: 'desktop',
    aliases: ['d-smart', 'smart', '智能'],
    id: 'mimo-desktop/mimo-auto',
    hint: '桌面 SSO smart-router',
    provider: 'mimo-desktop',
  },
  {
    key: 'default',
    label: '跟随配置',
    lane: 'default',
    aliases: ['default', '默认'],
    id: '',
    hint: '不传 -m',
    provider: '',
  },
]
