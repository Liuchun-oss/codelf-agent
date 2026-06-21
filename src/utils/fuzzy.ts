


export interface FuzzyResult {
  matched: boolean
  score: number
  
  positions: number[]
}

export function fuzzyMatch(query: string, target: string): FuzzyResult {
  if (!query) return { matched: true, score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let qi = 0
  let score = 0
  let prevIdx = -1
  const positions: number[] = []

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    positions.push(ti)
    
    if (prevIdx === ti - 1) score += 5
    else score += 1
    
    const prevChar = ti > 0 ? target[ti - 1] : ''
    if (ti === 0 || prevChar === '/' || prevChar === '\\' || prevChar === '.' || prevChar === '_' || prevChar === '-') {
      score += 8
    }
    prevIdx = ti
    qi++
  }

  if (qi < q.length) return { matched: false, score: 0, positions: [] }
  
  score += Math.max(0, 30 - target.length) * 0.1
  return { matched: true, score, positions }
}

export interface RankedItem<T> {
  item: T
  score: number
  positions: number[]
}

export function fuzzyRank<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit = 200
): RankedItem<T>[] {
  const out: RankedItem<T>[] = []
  for (const item of items) {
    const r = fuzzyMatch(query, getText(item))
    if (r.matched) out.push({ item, score: r.score, positions: r.positions })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}
