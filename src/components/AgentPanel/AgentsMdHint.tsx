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

const EXAMPLE_AGENT_TEMPLATE = `---
title: 示例子 Agent
description: 一句话说明这个子 Agent 负责什么
readOnly: true
# model: 可选。填你在设置里配置的模型名/Provider 名，留空则用当前激活模型
---

你是「示例」子 Agent。

职责：
- （描述这个子 Agent 要做的事）

硬性约束：
- readOnly: true 时只能调查/分析/总结，不要修改文件；改为 false 才能写文件、跑命令。
- 优先用工具读取真实内容，不要凭空想象。
- 输出结构化、附带关键文件与证据。
`

function joinPath(root: string, ...segs: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  return [trimmed, ...segs].join(sep)
}

export default function AgentsMdHint({ workspaceRoot }: AgentsMdHintProps): JSX.Element | null {
  const [hasAgentsMd, setHasAgentsMd] = useState(true)
  const [hasProjectAgent, setHasProjectAgent] = useState(true)
  const [creating, setCreating] = useState<null | 'agentsMd' | 'subagent'>(null)
  const openFile = useEditorStore((s) => s.openFile)

  useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) {
      setHasAgentsMd(true)
      setHasProjectAgent(true)
      return
    }
    void Promise.all([
      window.lc.exists(joinPath(workspaceRoot, '.codelf', 'AGENTS.md')),
      window.lc.exists(joinPath(workspaceRoot, '.codelf', 'agents.md')),
      window.lc.exists(joinPath(workspaceRoot, 'AGENTS.md')),
      window.lc.exists(joinPath(workspaceRoot, 'agents.md'))
    ])
      .then((found) => {
        if (!cancelled) setHasAgentsMd(found.some(Boolean))
      })
      .catch(() => {
        if (!cancelled) setHasAgentsMd(true)
      })
    void window.lc
      .aiListAgentDefinitions(workspaceRoot)
      .then((defs) => {
        if (!cancelled) setHasProjectAgent(defs.some((d) => d.source === 'project'))
      })
      .catch(() => {
        if (!cancelled) setHasProjectAgent(true)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  if (!workspaceRoot || (hasAgentsMd && hasProjectAgent)) return null

  const createAgentsMd = async (): Promise<void> => {
    setCreating('agentsMd')
    try {
      const target = joinPath(workspaceRoot, '.codelf', 'AGENTS.md')
      const ok = await window.lc.writeFile(target, AGENTS_MD_TEMPLATE)
      if (!ok) {
        toast.error('创建 AGENTS.md 失败')
        return
      }
      setHasAgentsMd(true)
      await openFile(target, 'AGENTS.md')
      toast.info('已创建 .codelf/AGENTS.md，内容会自动注入到对话上下文')
    } catch {
      toast.error('创建 AGENTS.md 失败')
    } finally {
      setCreating(null)
    }
  }

  const createSubagent = async (): Promise<void> => {
    setCreating('subagent')
    try {
      const target = joinPath(workspaceRoot, '.codelf', 'agents', 'example.md')
      const ok = await window.lc.writeFile(target, EXAMPLE_AGENT_TEMPLATE)
      if (!ok) {
        toast.error('创建示例子 Agent 失败')
        return
      }
      setHasProjectAgent(true)
      await openFile(target, 'example.md')
      toast.info('已创建示例子 Agent，编辑后主 Agent 即可通过 subagentType 调用')
    } catch {
      toast.error('创建示例子 Agent 失败')
    } finally {
      setCreating(null)
    }
  }

  return (
    <div className="agents-md-hint">
      <span className="agents-md-hint-text">
        可选：放 <code>.codelf/AGENTS.md</code> 写项目约定（每轮自动注入），或在 <code>.codelf/agents/</code>{' '}
        放自定义子 Agent（可单独指定模型）。不创建也不影响使用。
      </span>
      <div className="agents-md-hint-actions">
        {!hasAgentsMd && (
          <button type="button" className="btn-link" disabled={creating !== null} onClick={() => void createAgentsMd()}>
            {creating === 'agentsMd' ? '创建中…' : '创建 AGENTS.md'}
          </button>
        )}
        {!hasProjectAgent && (
          <button type="button" className="btn-link" disabled={creating !== null} onClick={() => void createSubagent()}>
            {creating === 'subagent' ? '创建中…' : '创建示例子 Agent'}
          </button>
        )}
      </div>
    </div>
  )
}
