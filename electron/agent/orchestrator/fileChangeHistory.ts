import { promises as fs } from 'fs'
import { writeFileAtomic, writeTextFile, type FileEncoding } from '../../services/fsService'
import { noteAgentWrite } from '../../services/localWriteRegistry'

interface FileChangeRecord {
  changeId: string
  path: string
  encoding: FileEncoding
  // 写盘前的原始字节（用于撤销）。oldExisted 为 false 表示该文件是新建的。
  oldExisted: boolean
  oldData: Buffer
  // AI 写入的新文本内容（用于取消撤销 / redo）。
  newContent: string
  state: 'applied' | 'reverted'
}

/**
 * 按 changeId 记录每一次 AI 写盘的前后内容，支持单个变更的撤销与取消撤销。
 * 与 TurnCheckpoint（整回合回滚）相互独立，粒度更细。
 */
export class FileChangeHistory {
  private records = new Map<string, FileChangeRecord>()
  // 同一 changeId 的撤销/取消撤销操作串行化，消除 IPC 边界并发调用时
  // “检查 state → await 写盘 → 改 state”之间的 TOCTOU 窗口。
  private locks = new Map<string, Promise<unknown>>()

  private runExclusive<T>(changeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(changeId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      changeId,
      next.catch(() => undefined)
    )
    return next
  }

  /** 在写盘之前调用，抓取目标文件的原始字节并登记一条记录。 */
  async captureBeforeWrite(
    changeId: string,
    path: string,
    encoding: FileEncoding,
    newContent: string
  ): Promise<void> {
    let oldExisted = true
    let oldData = Buffer.alloc(0)
    try {
      oldData = await fs.readFile(path)
    } catch {
      oldExisted = false
    }
    this.records.set(changeId, {
      changeId,
      path,
      encoding,
      oldExisted,
      oldData,
      newContent,
      state: 'applied'
    })
  }

  hasRecord(changeId: string): boolean {
    return this.records.has(changeId)
  }

  pathOf(changeId: string): string | undefined {
    return this.records.get(changeId)?.path
  }

  /** 撤销单个变更：写回旧内容（新建文件则删除）。 */
  revert(changeId: string): Promise<boolean> {
    return this.runExclusive(changeId, async () => {
      const rec = this.records.get(changeId)
      if (!rec || rec.state === 'reverted') return false
      try {
        if (rec.oldExisted) {
          await writeFileAtomic(rec.path, rec.oldData)
        } else {
          await fs.rm(rec.path, { force: true })
        }
        noteAgentWrite(rec.path)
        rec.state = 'reverted'
        return true
      } catch {
        return false
      }
    })
  }

  /** 取消撤销单个变更：重新写入 AI 的新内容。 */
  redo(changeId: string): Promise<boolean> {
    return this.runExclusive(changeId, async () => {
      const rec = this.records.get(changeId)
      if (!rec || rec.state === 'applied') return false
      try {
        await writeTextFile(rec.path, rec.newContent, rec.encoding)
        noteAgentWrite(rec.path)
        rec.state = 'applied'
        return true
      } catch {
        return false
      }
    })
  }

  clear(): void {
    this.records.clear()
    this.locks.clear()
  }
}
