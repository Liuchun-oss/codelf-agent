

export interface DiffHunk {
  
  newLineAnchor: number
  
  oldLines: string[]
  
  newLines: string[]
  
  newStart: number
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  addCount: number
  delCount: number
}


export function reconstructNewContent(diff: string): string {
  if (!diff) return ''
  const lines = diff.split('\n')
  const result: string[] = []
  for (const line of lines) {
    if (line.startsWith('-')) continue
    if (line.startsWith('+')) {
      result.push(line.slice(1))
    } else {
      result.push(line.startsWith(' ') ? line.slice(1) : line)
    }
  }
  return result.join('\n')
}


export function reconstructOldContent(diff: string): string {
  if (!diff) return ''
  const lines = diff.split('\n')
  const result: string[] = []
  for (const line of lines) {
    if (line.startsWith('+')) continue
    if (line.startsWith('-')) {
      result.push(line.slice(1))
    } else {
      result.push(line.startsWith(' ') ? line.slice(1) : line)
    }
  }
  return result.join('\n')
}

export function parseDiff(diff: string): ParsedDiff {
  if (!diff) return { hunks: [], addCount: 0, delCount: 0 }

  const lines = diff.split('\n')
  const hunks: DiffHunk[] = []
  let addCount = 0
  let delCount = 0

  
  
  
  
  let newLine = 1
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith(' ') || (!line.startsWith('+') && !line.startsWith('-'))) {
      
      newLine++
      i++
      continue
    }

    
    const oldLines: string[] = []
    const newLines: string[] = []
    const anchorLine = newLine 

    
    while (i < lines.length && lines[i].startsWith('-')) {
      oldLines.push(lines[i].slice(1))
      delCount++
      i++
    }

    
    const newStart = newLine
    while (i < lines.length && lines[i].startsWith('+')) {
      newLines.push(lines[i].slice(1))
      addCount++
      newLine++
      i++
    }

    hunks.push({ newLineAnchor: anchorLine, oldLines, newLines, newStart })
  }

  return { hunks, addCount, delCount }
}
