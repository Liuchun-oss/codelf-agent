
export const MAX_CONSECUTIVE_DENIALS = 3


export class DenialTracker {
  private consecutive = 0

  recordDenial(): void {
    this.consecutive++
  }

  recordSuccess(): void {
    this.consecutive = 0
  }

  shouldTerminate(): boolean {
    return this.consecutive >= MAX_CONSECUTIVE_DENIALS
  }

  get count(): number {
    return this.consecutive
  }

  reset(): void {
    this.consecutive = 0
  }
}

export function denialLimitMessage(limit = MAX_CONSECUTIVE_DENIALS): string {
  return `连续 ${limit} 次拒绝，已终止本轮。`
}
