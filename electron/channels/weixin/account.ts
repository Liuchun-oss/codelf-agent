// 微信凭证 + getUpdates 游标持久化。
// 高敏感的 bot_token 走 secrets 安全存储（见 11.4）；
// 非敏感的游标/账号 id/baseUrl 落到 userData 下的 json 文件。

import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getSecret, setSecret, deleteSecret, hasSecret } from '../../ipc/secrets'
import type { WeixinAccountState } from './types'

// secrets 里存 bot_token 的键名。
export const WEIXIN_TOKEN_KEY_REF = 'channels.weixin.botToken'

interface PersistedShape {
  accountId: string
  userId?: string
  baseUrl: string
  get_updates_buf: string
  savedAt: string
}

function stateFile(): string {
  return join(app.getPath('userData'), 'weixin-channel.json')
}

function readPersisted(): PersistedShape | null {
  const file = stateFile()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PersistedShape
    if (parsed && typeof parsed.accountId === 'string') return parsed
    return null
  } catch {
    console.error('[weixin] weixin-channel.json 解析失败')
    return null
  }
}

function writePersisted(shape: PersistedShape): void {
  const target = stateFile()
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8')
    renameSync(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw e
  }
}

// 读取完整账号状态（token 从 secrets 取）。无凭证返回 null。
export function loadAccount(): WeixinAccountState | null {
  const persisted = readPersisted()
  if (!persisted) return null
  const token = getSecret(WEIXIN_TOKEN_KEY_REF)
  if (!token) return null
  return {
    token,
    accountId: persisted.accountId,
    userId: persisted.userId,
    baseUrl: persisted.baseUrl,
    get_updates_buf: persisted.get_updates_buf ?? '',
    savedAt: persisted.savedAt
  }
}

export function hasAccount(): boolean {
  return readPersisted() !== null && hasSecret(WEIXIN_TOKEN_KEY_REF)
}

// 保存完整账号（登录成功时调用）。
export function saveAccount(state: WeixinAccountState): void {
  setSecret(WEIXIN_TOKEN_KEY_REF, state.token)
  writePersisted({
    accountId: state.accountId,
    userId: state.userId,
    baseUrl: state.baseUrl,
    get_updates_buf: state.get_updates_buf ?? '',
    savedAt: state.savedAt
  })
}

// 仅更新游标（长轮询每次推进水位线时调用，高频，故不动 secrets）。
export function saveCursor(buf: string): void {
  const persisted = readPersisted()
  if (!persisted) return
  if (persisted.get_updates_buf === buf) return
  writePersisted({ ...persisted, get_updates_buf: buf })
}

// 清除凭证（断开/重新登录时）。
export function clearAccount(): void {
  deleteSecret(WEIXIN_TOKEN_KEY_REF)
  try {
    const file = stateFile()
    if (existsSync(file)) rmSync(file, { force: true })
  } catch {
    // ignore
  }
}
