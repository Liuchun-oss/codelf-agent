import { useEffect, useState } from 'react'
import { useEditorStore } from '@/stores/editorStore'
import { toast } from '@/stores/toastStore'

interface AgentsMdHintProps {
  /** 当前工作区根目录，缺省时不显示提示 */
  workspaceRoot?: string
}

const AGENTS_MD_TEMPLATE = `# AGENTS.md

> 本文件中的内容会在每轮对话时自动注入到 AI 的系统提示词中（上限 32KB）。
> 用它告诉 Agent 这个项目的约定、技术栈、目录结构与偏好，让回答更贴合你的项目。
> 修改保存后下一轮对话即时生效，无需重启。

## 项目简介

（一句话说明这个项目是做什么的）

## 技术栈与约定

- 语言/框架：
- 代码风格：
- 测试方式：

## 目录结构

（列出关键目录及其职责）

## 给 Agent 的偏好

- 用简体中文回复
- 修改前先说明思路
`

function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  return `${trimmed}${sep}${name}`
}

export default function AgentsMdHint({ workspaceRoot }: AgentsMdHintProps): JSX.Element | null {
  const [hidden, setHidden] = useState(true)
  const [creating, setCreating] = useState(false)
  const openFile = useEditorStore((s) => s.openFile)

  useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) {
      setHidden(true)
      return
    }
    void Promise.all([
      window.lc.exists(joinPath(workspaceRoot, 'AGENTS.md')),
      window.lc.exists(joinPath(workspaceRoot, 'agents.md'))
    ])
      .then(([upper, lower]) => {
        if (!cancelled) setHidden(upper || lower)
      })
      .catch(() => {
        if (!cancelled) setHidden(true)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  if (hidden || !workspaceRoot) return null

  const handleCreate = async (): Promise<void> => {
    setCreating(true)
    try {
      const target = joinPath(workspaceRoot, 'AGENTS.md')
      const ok = await window.lc.writeFile(target, AGENTS_MD_TEMPLATE)
      if (!ok) {
        toast.error('创建 AGENTS.md 失败')
        return
      }
      setHidden(true)
      await openFile(target, 'AGENTS.md')
      toast.info('已创建 AGENTS.md，内容会自动注入到对话上下文')
    } catch {
      toast.error('创建 AGENTS.md 失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="agents-md-hint">
      <span className="agents-md-hint-text">
        提示：在项目根目录放一个 <code>AGENTS.md</code>，其内容会自动注入到每轮对话的上下文，让 Agent 了解你的项目约定。这是可选的，不创建也不影响正常使用。
      </span>
      <button type="button" className="btn-link" disabled={creating} onClick={() => void handleCreate()}>
        {creating ? '创建中…' : '一键创建'}
      </button>
    </div>
  )
}
