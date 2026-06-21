
const MAX_DIFF_LINES = 4000
const CONTEXT_LINES = 3

export function computeLineDiff(oldText: string, newText: string): string {
  const a = oldText.length ? oldText.split('\n') : []
  const b = newText.length ? newText.split('\n') : []
  const m = a.length
  const n = b.length

  // 裁掉首尾完全相同的行，只对真正发生变化的中间区域做 O(mid^2) 的 LCS。
  // 这样即便是超大文件，只要改动局部，依然能算出真实的逐行 diff。
  let prefix = 0
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < m - prefix && suffix < n - prefix && a[m - 1 - suffix] === b[n - 1 - suffix]) suffix++

  const aMid = a.slice(prefix, m - suffix)
  const bMid = b.slice(prefix, n - suffix)

  // 仅当真正发生分歧的区域本身巨大时才降级，避免内存/耗时失控。
  if (aMid.length + bMid.length > MAX_DIFF_LINES) {
    return `@@ 改动区域过大，省略逐行 diff @@\n- 原 ${m} 行\n+ 新 ${n} 行`
  }

  const out: string[] = []
  for (let k = 0; k < prefix; k++) out.push(' ' + a[k])
  appendMidDiff(out, aMid, bMid)
  for (let k = m - suffix; k < m; k++) out.push(' ' + a[k])

  return collapseContext(out)
}

function appendMidDiff(out: string[], a: string[], b: string[]): void {
  const m = a.length
  const n = b.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('-' + a[i])
      i++
    } else {
      out.push('+' + b[j])
      j++
    }
  }
  while (i < m) out.push('-' + a[i++])
  while (j < n) out.push('+' + b[j++])
}

function collapseContext(lines: string[]): string {
  
  
  const isChange = (l: string): boolean => l.startsWith('+') || l.startsWith('-')
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let k = 0; k < lines.length; k++) {
    if (!isChange(lines[k])) continue
    const from = Math.max(0, k - CONTEXT_LINES)
    const to = Math.min(lines.length - 1, k + CONTEXT_LINES)
    for (let p = from; p <= to; p++) keep[p] = true
  }

  
  const hasChange = lines.some(isChange)
  if (!hasChange) return lines.join('\n')

  const result: string[] = []
  let skipped = 0
  const flushGap = (): void => {
    if (skipped > 0) {
      result.push(`@@ 省略 ${skipped} 行未改动 @@`)
      skipped = 0
    }
  }
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      flushGap()
      result.push(lines[k])
    } else {
      skipped++
    }
  }
  flushGap()
  return result.join('\n')
}


export function diffHasChanges(diff: string): boolean {
  return diff.split('\n').some((l) => l.startsWith('+') || l.startsWith('-'))
}
