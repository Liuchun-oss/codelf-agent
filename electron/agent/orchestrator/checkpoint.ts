import { promises as fs } from 'fs'
import { writeFileAtomic } from '../../services/fsService'
import { noteAgentWrite } from '../../services/localWriteRegistry'


interface Snapshot {
  existed: boolean
  data: Buffer
}

export class TurnCheckpoint {
  private current = new Map<string, Snapshot>()
  private last = new Map<string, Snapshot>()

  beginTurn(): void {
    this.current = new Map()
  }

  
  async snapshot(path: string): Promise<void> {
    if (this.current.has(path)) return
    try {
      const data = await fs.readFile(path)
      this.current.set(path, { existed: true, data })
    } catch {
      
      this.current.set(path, { existed: false, data: Buffer.alloc(0) })
    }
  }

  
  finalizeTurn(): void {
    if (this.current.size > 0) {
      this.last = this.current
    }
    this.current = new Map()
  }

  hasRevertable(): boolean {
    return this.last.size > 0
  }

  
  async revert(): Promise<number> {
    let count = 0
    for (const [path, snap] of this.last.entries()) {
      try {
        if (snap.existed) {
          await writeFileAtomic(path, snap.data)
        } else {
          await fs.rm(path, { force: true })
        }
        noteAgentWrite(path)
        count++
      } catch {
        
      }
    }
    this.last = new Map()
    return count
  }
}
