import type { PermissionDecision } from '@shared/agentTypes'


export class PermissionBroker {
  private pending = new Map<string, (d: PermissionDecision) => void>()

  wait(requestId: string, signal?: AbortSignal): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      if (signal?.aborted) {
        resolve('deny')
        return
      }
      this.pending.set(requestId, resolve)
      signal?.addEventListener('abort', () => this.settle(requestId, 'deny'), { once: true })
    })
  }

  resolve(requestId: string, decision: PermissionDecision): void {
    this.settle(requestId, decision)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'deny')
  }

  private settle(requestId: string, decision: PermissionDecision): void {
    const resolver = this.pending.get(requestId)
    if (resolver) {
      this.pending.delete(requestId)
      resolver(decision)
    }
  }
}
