import { useEffect, useState, type ReactNode } from 'react'
import ImageLightbox from './ImageLightbox'
import { BROWSER_PREVIEW_SCHEME } from '@shared/appConfig'

export function parseBrowserPreviewId(src: string): string | null {
  const match = new RegExp(`^${BROWSER_PREVIEW_SCHEME}://(.+)$`).exec(src)
  return match ? decodeURIComponent(match[1]) : null
}

interface BrowserPreviewImageProps {
  previewId: string
  alt?: string
  className?: string
  fallback?: ReactNode
  loading?: ReactNode
}


export default function BrowserPreviewImage({
  previewId,
  alt,
  className,
  fallback,
  loading
}: BrowserPreviewImageProps): JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  useEffect(() => {
    let objectUrl: string | undefined
    let cancelled = false

    void window.lc
      .readBrowserPreview(previewId)
      .then((data) => {
        if (cancelled) return
        if (!data?.data) {
          setFailed(true)
          return
        }
        const binary = atob(data.data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime }))
        setBlobUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [previewId])

  if (failed) {
    return (
      <>
        {fallback ?? (
          <p className="agent-question-preview-fallback">预览图加载失败，请直接查看已打开的浏览器窗口。</p>
        )}
      </>
    )
  }

  if (!blobUrl) {
    return <>{loading ?? <p className="agent-question-preview-fallback">正在加载预览…</p>}</>
  }

  return (
    <span className="preview-image-wrapper">
      <img className={className} src={blobUrl} alt={alt ?? ''} loading="lazy" />
      <button
        className="preview-image-zoom-btn"
        onClick={() => setLightbox(true)}
        aria-label="放大查看"
        title="放大查看"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M6.5 1a5.5 5.5 0 0 1 4.38 8.82l3.65 3.65a.75.75 0 0 1-1.06 1.06l-3.65-3.65A5.5 5.5 0 1 1 6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM6.5 4a.5.5 0 0 1 .5.5V6h1.5a.5.5 0 0 1 0 1H7v1.5a.5.5 0 0 1-1 0V7H4.5a.5.5 0 0 1 0-1H6V4.5a.5.5 0 0 1 .5-.5Z" fill="currentColor"/>
        </svg>
      </button>
      {lightbox && <ImageLightbox src={blobUrl} alt={alt} onClose={() => setLightbox(false)} />}
    </span>
  )
}
