import { ipcMain } from 'electron'
import { checkEnvironment } from '../services/envCheckService'
import type { EnvCheckResult } from '@shared/envCheckTypes'

export function registerEnvIpc(): void {
  ipcMain.handle('env:check', async (): Promise<EnvCheckResult> => {
    return checkEnvironment()
  })
}
