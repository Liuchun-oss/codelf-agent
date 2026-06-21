
export function shouldConsumePickSignal(signal: number, lastHandled: number): boolean {
  return signal > 0 && signal > lastHandled
}
