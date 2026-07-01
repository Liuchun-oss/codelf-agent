import { type CSSProperties, type ReactNode, type RefObject } from 'react'

export interface LazyRowProps {
  scrollRef: RefObject<HTMLDivElement | null>
  forceMounted?: boolean
  estimatedHeight?: number
  children: ReactNode
}

const DEFAULT_ESTIMATED_HEIGHT = 120

/**
 * 懒渲染行。用 CSS content-visibility 而非「卸载再重挂 + 手动量高度」：
 * 内容始终保留在 DOM 中，浏览器只跳过视口外子树的布局与绘制，用
 * contain-intrinsic-size 的 auto 关键字自动记住上一次真实渲染高度作为占位尺寸。
 *
 * 旧实现滚出视口即卸载子内容、换成固定 minHeight 占位，滚回再重挂并异步重排
 * （markdown 高亮、图片、diff 编辑器）。两个后果：
 *   1) 记下的 minHeight 常与真实内容对不上 → 气泡上方/中间出现空白；
 *   2) 重挂到异步内容排版完之间有若干空帧 → 上滑时内容「没渲染」、要再滑一下才冒出。
 * content-visibility 不卸载、不重排，滚回即从既有 DOM 复用，彻底消除这两类空白/跳动。
 */
export default function LazyRow({
  forceMounted = false,
  estimatedHeight = DEFAULT_ESTIMATED_HEIGHT,
  children
}: LazyRowProps): JSX.Element {
  const style: CSSProperties | undefined = forceMounted
    ? undefined
    : ({
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${estimatedHeight}px`
      } as CSSProperties)
  return <div style={style}>{children}</div>
}
