import type { UserQuestionResponse } from '@shared/agentTypes'


export class UserQuestionBroker {
  private pending = new Map<string, (r: UserQuestionResponse) => void>()
  // 早到回答缓冲：与权限/文件变更 broker 同理，防止同步回填发生在 wait 之前导致丢失。
  private preResolved = new Map<string, UserQuestionResponse>()

  wait(requestId: string, signal?: AbortSignal): Promise<UserQuestionResponse> {
    return new Promise<UserQuestionResponse>((resolve) => {
      const early = this.preResolved.get(requestId)
      if (early !== undefined) {
        this.preResolved.delete(requestId)
        resolve(early)
        return
      }
      if (signal?.aborted) {
        resolve({ answer: '', cancelled: true })
        return
      }
      this.pending.set(requestId, resolve)
      signal?.addEventListener('abort', () => this.settle(requestId, { answer: '', cancelled: true }), {
        once: true
      })
    })
  }

  resolve(requestId: string, response: UserQuestionResponse): void {
    this.settle(requestId, response)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { answer: '', cancelled: true })
    this.preResolved.clear()
  }

  private settle(requestId: string, response: UserQuestionResponse): void {
    const resolver = this.pending.get(requestId)
    if (resolver) {
      this.pending.delete(requestId)
      resolver(response)
      return
    }
    this.preResolved.set(requestId, response)
  }
}
