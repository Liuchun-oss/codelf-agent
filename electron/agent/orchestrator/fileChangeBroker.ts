import type { FileChangeDecision } from '@shared/agentTypes'


export class FileChangeBroker {
  private pending = new Map<string, (d: FileChangeDecision) => void>()

  wait(changeId: string, signal?: AbortSignal): Promise<FileChangeDecision> {
    return new Promise<FileChangeDecision>((resolve) => {
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
  }

  private settle(changeId: string, decision: FileChangeDecision): void {
    const resolver = this.pending.get(changeId)
    if (resolver) {
      this.pending.delete(changeId)
      resolver(decision)
    }
  }
}
