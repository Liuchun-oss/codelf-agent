import type { PermissionDecision } from '@shared/agentTypes'


export class PermissionBroker {
  private pending = new Map<string, (d: PermissionDecision) => void>()
  // 早到决定缓冲：若 resolve 在 wait 之前到达（群聊同步自动裁决场景：引擎 yield
  // permission_request 后还停在 yield 处、尚未执行到 broker.wait，编排器已同步回填决定），
  // 先存起来，wait 时立即兑现，避免决定丢失导致引擎永久挂起（卡在「正在输入…」）。
  private preResolved = new Map<string, PermissionDecision>()

  wait(requestId: string, signal?: AbortSignal): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const early = this.preResolved.get(requestId)
      if (early !== undefined) {
        this.preResolved.delete(requestId)
        resolve(early)
        return
      }
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
    this.preResolved.clear()
  }

  private settle(requestId: string, decision: PermissionDecision): void {
    const resolver = this.pending.get(requestId)
    if (resolver) {
      this.pending.delete(requestId)
      resolver(decision)
      return
    }
    // 还没人 wait：缓冲下来，等 wait 时立即兑现。
    this.preResolved.set(requestId, decision)
  }
}
