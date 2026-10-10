/**
 * Persisted WeChat bot credentials for this machine.
 *
 * One bot account: id, token, the Weixin user it is bound to, and the API base.
 * Written by the CLI `login`, readable by the plugin — the same file serves both.
 * File mode is 0600 — it holds a bearer token that grants full bot access.
 *
 * @module mimo-desktop-wechat/account
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WeixinAccount } from '../core/types.ts'
import { mimoStateDir } from './mimo-gateway.ts'

export type StoredAccount = WeixinAccount

export function accountFile(): string {
  return join(mimoStateDir(), 'wechat', 'account.json')
}

export async function loadAccount(): Promise<StoredAccount | undefined> {
  try {
    const raw = await readFile(accountFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoredAccount
    if (parsed && typeof parsed.token === 'string' && typeof parsed.accountId === 'string') {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function saveAccount(account: StoredAccount): Promise<void> {
  const file = accountFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(account, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  try {
    await rename(temp, file)
    await chmod(file, 0o600)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function clearAccount(): Promise<void> {
  await rm(accountFile(), { force: true })
}
