import { useState } from 'react'
import type { ChatMessageView } from '@/stores/agentStore'
import { toolHeadlineArg } from '@/stores/agentStore'
import BrowserPreviewImage, { parseBrowserPreviewId } from './BrowserPreviewImage'
import ImageLightbox from './ImageLightbox'
import AudioPlayer from './AudioPlayer'
import { BROWSER_PREVIEW_SCHEME, ARTIFACT_FILE_SCHEME } from '@shared/appConfig'

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
    case 'GenerateImage':
      return '生成图片'
    case 'EditImage':
      return '编辑图片'
    case 'GenerateVideo':
      return '生成视频'
    case 'GenerateSpeech':
      return '生成语音'
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

// 提取工具结果里的 artifact 图片 URL（如 GenerateImage 返回的 codelf-artifact:// 图）。
const ARTIFACT_IMG_RE = new RegExp(`!\\[[^\\]]*\\]\\((${ARTIFACT_FILE_SCHEME}://[^)]+)\\)`, 'g')

function extractArtifactImageUrls(result: string | undefined): string[] {
  if (!result) return []
  const urls: string[] = []
  for (const m of result.matchAll(ARTIFACT_IMG_RE)) {
    // 排除视频（GenerateVideo 用 ![video](...mp4) 承载）与音频（GenerateSpeech 用 ![audio](...) 承载），
    // 它们单独提取渲染对应播放器。
    if (m[1] && !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(m[1]) && !/\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)(\?|#|$)/i.test(m[1])) {
      urls.push(m[1])
    }
  }
  return urls
}

// 提取工具结果里的 artifact 视频 URL（GenerateVideo 返回的 ![video](...mp4)）。
function extractArtifactVideoUrls(result: string | undefined): string[] {
  if (!result) return []
  const urls: string[] = []
  for (const m of result.matchAll(ARTIFACT_IMG_RE)) {
    if (m[1] && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(m[1])) urls.push(m[1])
  }
  return urls
}

// 提取工具结果里的 artifact 音频 URL（GenerateSpeech 返回的 ![audio](...)）。
function extractArtifactAudioUrls(result: string | undefined): string[] {
  if (!result) return []
  const urls: string[] = []
  for (const m of result.matchAll(ARTIFACT_IMG_RE)) {
    if (m[1] && /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac)(\?|#|$)/i.test(m[1])) urls.push(m[1])
  }
  return urls
}


function fullArgsText(toolName: string | undefined, args?: Record<string, unknown>): string {
  if (!args) return ''
  const parts = Object.entries(args).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`
  )
  return `${toolName ?? '工具'}\n${parts.join('\n')}`
}


function GeneratedImage({ src }: { src: string }): JSX.Element {
  const [zoom, setZoom] = useState(false)
  return (
    <span className="preview-image-wrapper">
      <img
        src={src}
        className="agent-tool-preview-img"
        alt="生成的图片"
        loading="lazy"
        onClick={() => setZoom(true)}
        style={{ cursor: 'zoom-in' }}
      />
      <button
        className="preview-image-zoom-btn"
        onClick={() => setZoom(true)}
        aria-label="放大查看"
        title="放大查看"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M6.5 1a5.5 5.5 0 0 1 4.38 8.82l3.65 3.65a.75.75 0 0 1-1.06 1.06l-3.65-3.65A5.5 5.5 0 1 1 6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM6.5 4a.5.5 0 0 1 .5.5V6h1.5a.5.5 0 0 1 0 1H7v1.5a.5.5 0 0 1-1 0V7H4.5a.5.5 0 0 1 0-1H6V4.5a.5.5 0 0 1 .5-.5Z" fill="currentColor"/>
        </svg>
      </button>
      {zoom && <ImageLightbox src={src} alt="生成的图片" onClose={() => setZoom(false)} />}
    </span>
  )
}

function GeneratedVideo({ src }: { src: string }): JSX.Element {
  return (
    <video className="agent-tool-preview-video" src={src} controls playsInline preload="metadata" />
  )
}

function GeneratedAudio({ src }: { src: string }): JSX.Element {
  return <AudioPlayer src={src} className="agent-tool-preview-audio" />
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
        const artifactImages = extractArtifactImageUrls(t.toolResult)
        const artifactVideos = extractArtifactVideoUrls(t.toolResult)
        const artifactAudios = extractArtifactAudioUrls(t.toolResult)
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
            {artifactImages.length > 0 && (
              <div className="agent-tool-previews">
                {artifactImages.map((url) => (
                  <GeneratedImage key={url} src={url} />
                ))}
              </div>
            )}
            {artifactVideos.length > 0 && (
              <div className="agent-tool-previews">
                {artifactVideos.map((url) => (
                  <GeneratedVideo key={url} src={url} />
                ))}
              </div>
            )}
            {artifactAudios.length > 0 && (
              <div className="agent-tool-previews">
                {artifactAudios.map((url) => (
                  <GeneratedAudio key={url} src={url} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
