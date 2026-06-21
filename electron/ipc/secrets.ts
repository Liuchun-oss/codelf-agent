import { ipcMain, safeStorage, app } from 'electron'
import {
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync
} from 'fs'
import { join, dirname, basename } from 'path'
import { randomBytes } from 'crypto'



type SecretStore = Record<string, string>

let cache: SecretStore | null = null

function secretsFile(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): SecretStore {
  if (cache) return cache
  const file = secretsFile()
  if (!existsSync(file)) {
    cache = {}
    return cache
  }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as SecretStore)
        : {}
  } catch {
    
    console.error('[secrets] secrets.json 解析失败，按空存储处理')
    cache = {}
  }
  return cache
}

function persist(store: SecretStore): void {
  const target = secretsFile()
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      
    }
    throw e
  }
}

export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}


export function setSecret(key: string, value: string): void {
  if (!key) throw new Error('密钥名不能为空')
  if (!isSecretStorageAvailable()) {
    throw new Error('系统不支持安全存储，无法保存密钥；请升级操作系统或改用环境变量')
  }
  const store = load()
  const encrypted = safeStorage.encryptString(value).toString('base64')
  store[key] = encrypted
  persist(store)
}


export function getSecret(key: string): string | null {
  if (!key) return null
  const store = load()
  const enc = store[key]
  if (enc === undefined) return null
  if (!isSecretStorageAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    console.error('[secrets] 解密失败（可能换了系统账户或密钥环）')
    return null
  }
}


export function hasSecret(key: string): boolean {
  if (!key) return false
  const store = load()
  return Object.prototype.hasOwnProperty.call(store, key)
}


export function deleteSecret(key: string): void {
  if (!key) return
  const store = load()
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    delete store[key]
    persist(store)
  }
}

export function registerSecretsIpc(): void {
  ipcMain.handle('secrets:isAvailable', async (): Promise<boolean> => isSecretStorageAvailable())

  ipcMain.handle(
    'secrets:set',
    async (_e, key: string, value: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        setSecret(key, value)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '保存密钥失败' }
      }
    }
  )

  ipcMain.handle('secrets:has', async (_e, key: string): Promise<boolean> => hasSecret(key))

  ipcMain.handle('secrets:delete', async (_e, key: string): Promise<{ ok: boolean }> => {
    deleteSecret(key)
    return { ok: true }
  })

  
}
