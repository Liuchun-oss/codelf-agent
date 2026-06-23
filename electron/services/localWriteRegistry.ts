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

// 向渲染进程主窗口发送任意事件（供 agent 工具驱动 UI，如在内置浏览器打开 URL）。
// 返回是否成功投递（窗口存在且未销毁）。
export function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  if (target && !target.isDestroyed()) {
    target.send(channel, ...args)
    return true
  }
  return false
}
