
export function isBenignUnhandledRejection(reason: unknown): boolean {
  if (reason == null) return false

  const msg = reason instanceof Error ? reason.message : String(reason)
  const name = reason instanceof Error ? reason.name : ''

  if (msg === 'Canceled' || name === 'Canceled') return true
  if (msg === 'Model not found') return true

  return false
}
