import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { APP_NAME } from '@shared/appConfig'



let logPath = ''

function ts(): string {
  return new Date().toISOString()
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[${ts()}] [${level.toUpperCase()}] ${message}\n`
  try {
    if (logPath) appendFileSync(logPath, line)
  } catch {
    
  }
  if (level === 'error') console.error(line.trimEnd())
}

export function initLogging(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'main.log')
  } catch {
    
  }

  process.on('uncaughtException', (err) => {
    log('error', `uncaughtException: ${err?.stack ?? err}`)
  })
  process.on('unhandledRejection', (reason) => {
    log('error', `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  })

  log('info', `${APP_NAME} 启动 v${app.getVersion()}`)
}
