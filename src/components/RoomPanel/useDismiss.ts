import { useCallback, useState } from 'react'

// 弹窗/抽屉「先播退场动画再卸载」的通用 hook（§7.2 动画）。
// 用法：把 requestClose 接到所有关闭入口（遮罩点击、关闭按钮、Esc），
// closing 为 true 时给根元素加 .closing 类切到退场动画，
// onAnimationEnd 挂在「会播退场动画的那个元素」上，动画结束后真正 onClose。
export function useDismiss(onClose: () => void): {
  closing: boolean
  requestClose: () => void
  onAnimationEnd: (e: React.AnimationEvent) => void
} {
  const [closing, setClosing] = useState(false)
  const requestClose = useCallback(() => setClosing(true), [])
  const onAnimationEnd = useCallback(
    (e: React.AnimationEvent): void => {
      if (e.currentTarget !== e.target) return
      if (closing) onClose()
    },
    [closing, onClose]
  )
  return { closing, requestClose, onAnimationEnd }
}
