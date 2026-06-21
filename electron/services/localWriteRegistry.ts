import type { WebContents } from 'electron'
import { suppressWatchPath } from '../ipc/watcher'



let target: WebContents | null = null

export function setLocalWriteTarget(wc: WebContents | null): void {
  target = wc
}


export function noteAgentWrite(filePath: string): void {
  suppressWatchPath(filePath)
  if (target && !target.isDestroyed()) {
    target.send('fs:agentWrote', { path: filePath })
  }
}
