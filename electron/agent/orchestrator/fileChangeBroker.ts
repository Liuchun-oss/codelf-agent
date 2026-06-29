import type { FileChangeDecision } from '@shared/agentTypes'


export class FileChangeBroker {
  private pending = new Map<string, (d: FileChangeDecision) => void>()
  // 早到决定缓冲：群聊里编排器在收到 file_change_proposed 事件时同步回填 accept/reject，
  // 但引擎此刻还停在 yield 处、尚未执行到 wait，决定会丢失致引擎永久挂起。先缓冲，wait 时兑现。
  private preResolved = new Map<string, FileChangeDecision>()

  wait(changeId: string, signal?: AbortSignal): Promise<FileChangeDecision> {
    return new Promise<FileChangeDecision>((resolve) => {
      const early = this.preResolved.get(changeId)
      if (early !== undefined) {
        this.preResolved.delete(changeId)
        resolve(early)
        return
      }
      if (signal?.aborted) {
        resolve('reject')
        return
      }
      this.pending.set(changeId, resolve)
      signal?.addEventListener('abort', () => this.settle(changeId, 'reject'), { once: true })
    })
  }

  
  waitAutoAccept(changeId: string, delayMs: number, signal?: AbortSignal): Promise<FileChangeDecision> {
    return new Promise<FileChangeDecision>((resolve) => {
      const early = this.preResolved.get(changeId)
      if (early !== undefined) {
        this.preResolved.delete(changeId)
        resolve(early)
        return
      }
      if (signal?.aborted) {
        resolve('reject')
        return
      }
      const finish = (d: FileChangeDecision): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const resolver = this.pending.get(changeId)
        if (resolver) {
          this.pending.delete(changeId)
          resolver(d)
        } else {
          resolve(d)
        }
      }
      this.pending.set(changeId, finish)
      const onAbort = (): void => finish('reject')
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => finish('accept'), delayMs)
    })
  }

  resolve(changeId: string, decision: FileChangeDecision): void {
    this.settle(changeId, decision)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'reject')
    this.preResolved.clear()
  }

  private settle(changeId: string, decision: FileChangeDecision): void {
    const resolver = this.pending.get(changeId)
    if (resolver) {
      this.pending.delete(changeId)
      resolver(decision)
      return
    }
    this.preResolved.set(changeId, decision)
  }
}
