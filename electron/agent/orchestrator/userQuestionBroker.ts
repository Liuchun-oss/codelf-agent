import type { UserQuestionResponse } from '@shared/agentTypes'


export class UserQuestionBroker {
  private pending = new Map<string, (r: UserQuestionResponse) => void>()

  wait(requestId: string, signal?: AbortSignal): Promise<UserQuestionResponse> {
    return new Promise<UserQuestionResponse>((resolve) => {
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
  }

  private settle(requestId: string, response: UserQuestionResponse): void {
    const resolver = this.pending.get(requestId)
    if (resolver) {
      this.pending.delete(requestId)
      resolver(response)
    }
  }
}
