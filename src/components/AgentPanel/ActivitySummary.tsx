import type { ChatMessageView } from '@/stores/agentStore'
import { toolHeadlineArg } from '@/stores/agentStore'
import BrowserPreviewImage, { parseBrowserPreviewId } from './BrowserPreviewImage'
import { BROWSER_PREVIEW_SCHEME } from '@shared/appConfig'

interface Props {
  tools: ChatMessageView[]
}

function toolLabel(toolName: string | undefined): string {
  switch (toolName) {
    case 'read_file':
      return '读取'
    case 'list_dir':
      return '列出'
    case 'grep':
    case 'search':
      return '搜索'
    case 'codebase_search':
      return '语义搜索'
    case 'get_diagnostics':
      return '检查诊断'
    case 'run_subagent':
      return '子 Agent'
    case 'edit_file':
      return '编辑文件'
    case 'write_file':
      return '写入文件'
    case 'delete_file':
      return '删除文件'
    default:
      return toolName ?? '工具'
  }
}

function statusLabel(tool: ChatMessageView): string {
  if (tool.toolStatus === 'background' || tool.toolStatus === 'deferred') return tool.toolProgress?.at(-1) ?? '后台执行中'
  if (tool.toolStatus === 'running') return tool.toolProgress?.at(-1) ?? '运行中'
  if (tool.toolStatus === 'error') return '失败'
  if (typeof tool.toolDurationMs === 'number') return `${Math.max(0, Math.round(tool.toolDurationMs))}ms`
  return '完成'
}

const PREVIEW_RE = new RegExp(`!\\[[^\\]]*\\]\\((${BROWSER_PREVIEW_SCHEME}://[^)]+)\\)`, 'g')

function extractPreviewIds(result: string | undefined): string[] {
  if (!result) return []
  const ids: string[] = []
  for (const m of result.matchAll(PREVIEW_RE)) {
    const id = parseBrowserPreviewId(m[1])
    if (id) ids.push(id)
  }
  return ids
}


function fullArgsText(toolName: string | undefined, args?: Record<string, unknown>): string {
  if (!args) return ''
  const parts = Object.entries(args).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`
  )
  return `${toolName ?? '工具'}\n${parts.join('\n')}`
}


export default function ActivitySummary({ tools }: Props): JSX.Element | null {
  const visibleTools = tools.filter(
    (t) => t.toolName !== 'edit_file' && t.toolName !== 'write_file' && t.toolName !== 'run_subagent'
  )
  if (visibleTools.length === 0) return null

  return (
    <div className="agent-tool-list" aria-label="工具调用">
      {visibleTools.map((t) => {
        const headline = toolHeadlineArg(t.toolName, t.toolArgs)
        const fullText = fullArgsText(t.toolName, t.toolArgs)
        const previewIds = extractPreviewIds(t.toolResult)
        return (
          <div key={t.id} className="agent-tool-entry">
            <span className={`agent-tool-item ${t.toolStatus ?? 'done'}`}>
              <span className="agent-tool-dot" aria-hidden />
              <span className="agent-tool-name">{toolLabel(t.toolName)}</span>
              {headline ? (
                <span className="agent-tool-arg-wrap">
                  <span className="agent-tool-arg">{headline}</span>
                  <span className="agent-tool-arg-tooltip">{fullText}</span>
                </span>
              ) : null}
              <span className="agent-tool-status">{statusLabel(t)}</span>
            </span>
            {previewIds.length > 0 && (
              <div className="agent-tool-previews">
                {previewIds.map((pid) => (
                  <BrowserPreviewImage key={pid} previewId={pid} className="agent-tool-preview-img" alt="Browser screenshot" />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
