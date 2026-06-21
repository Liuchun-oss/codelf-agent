import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const NEAR_BOTTOM_PX = 80

/**
 * 聊天滚动跟随。核心原则：跟随（followRef）只能被「真实用户手势」关闭——
 * 滚轮上滚 / 方向键 / 触摸拖动 / 按住滚动条。布局抖动（虚拟化折叠、异步高亮、
 * 图片加载、diff 编辑器挂载）引发的被动 scroll 事件 *永远不会* 关闭跟随，
 * 因此不再需要任何“时间锁”——以前用固定 260ms 锁窗口保护贴底，而会话切换后
 * 的异步布局经常晚于锁过期，clamp/锚定滚动被误判成用户上滚，跟随被错误关闭，
 * 这正是“切换会话后不在底部”的根因。
 */
export function useAgentChatScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  endRef: RefObject<HTMLDivElement | null>,
  lastUserId: string | undefined,
  tick: unknown,
  resetKey?: string
): void {
  const followRef = useRef(true)
  // 自上次贴底以来，用户是否做出过“想离开底部”的手势。
  const userIntentRef = useRef(false)
  const prevUserIdRef = useRef(lastUserId)
  const prevResetKeyRef = useRef(resetKey)
  const frameRef = useRef<number | null>(null)
  const firstLayoutRef = useRef(true)
  const settleFrameRef = useRef<number | null>(null)

  const pin = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }

  // 跟随式补滚：每一帧都重新校验 followRef，一旦用户手动上滚立即停止。
  const scheduleFollow = (): void => {
    if (!followRef.current) return
    pin()
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      if (!followRef.current) return
      pin()
      frameRef.current = requestAnimationFrame(() => {
        if (followRef.current) pin()
      })
    })
  }

  // 强制贴底（首次布局 / 切换会话 / 新一轮提问）：恢复跟随并清除用户意图。
  // 关键：settle 窗口内用 rAF *逐帧* 贴底，而不是稀疏的定时器补滚——
  // 异步内容（高亮、图片、diff 编辑器）分批撑高时，稀疏补滚之间的帧会以
  // “非底部”位置被绘制出来，肉眼看就是切换后画面往下滚。rAF 回调在每帧
  // 绘制前执行，逐帧先钉死 scrollTop，保证绘制出的每一帧都已在底部。
  const SETTLE_MS = 800
  const forceToBottom = (): void => {
    followRef.current = true
    userIntentRef.current = false
    pin()
    if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current)
    const deadline = performance.now() + SETTLE_MS
    const step = (): void => {
      // 用户在 settle 期间上滚（wheel/键盘会立即置 followRef=false）则马上退出。
      if (!followRef.current) {
        settleFrameRef.current = null
        return
      }
      pin()
      settleFrameRef.current =
        performance.now() < deadline ? requestAnimationFrame(step) : null
    }
    settleFrameRef.current = requestAnimationFrame(step)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = (): number => el.scrollHeight - el.scrollTop - el.clientHeight
    const onScroll = (): void => {
      if (distanceFromBottom() <= NEAR_BOTTOM_PX) {
        // 回到底部（无论是用户拖回还是补滚到达）：恢复跟随。
        followRef.current = true
        userIntentRef.current = false
      } else if (userIntentRef.current) {
        // 离开底部且确有用户手势：关闭跟随。
        followRef.current = false
      }
      // 离开底部但无用户手势 = 布局抖动（clamp / 异步内容撑高），
      // 保持跟随，交给 ResizeObserver 的下一次 scheduleFollow 重新贴底。
    }
    // 滚轮上滚 / 上翻按键是明确的离开意图，立即生效（流式输出时内容被
    // 持续钉在底部，scroll 距离可能还没拉开，不能只依赖 scroll 事件）。
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) {
        userIntentRef.current = true
        followRef.current = false
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
        userIntentRef.current = true
        followRef.current = false
      }
    }
    // 触摸拖动 / 按住滚动条（pointerdown 落在容器上）只标记意图，
    // 是否真的离开底部交由后续 scroll 事件判定。
    const markIntent = (): void => {
      userIntentRef.current = true
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', markIntent, { passive: true })
    el.addEventListener('pointerdown', markIntent)
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', markIntent)
      el.removeEventListener('pointerdown', markIntent)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // 只建一次 ResizeObserver；子节点的增减用 MutationObserver 动态挂/卸，
    // 避免把 tick（= 整个 messages）放进依赖里导致每个流式 token 都 disconnect/
    // new/observe 全部子节点（强制 reflow，是流式 CPU 的主要来源之一）。
    const ro = new ResizeObserver(() => scheduleFollow())
    ro.observe(el)
    const observed = new Set<Element>()
    for (const child of Array.from(el.children)) {
      ro.observe(child)
      observed.add(child)
    }
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            for (const child of Array.from(el.children)) {
              if (!observed.has(child)) {
                ro.observe(child)
                observed.add(child)
              }
            }
            for (const child of Array.from(observed)) {
              if (child.parentNode !== el) {
                ro.unobserve(child)
                observed.delete(child)
              }
            }
            scheduleFollow()
          })
        : null
    mo?.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo?.disconnect()
    }
  }, [scrollRef])

  // 首次布局 / 切换会话：在绘制前同步贴底，避免先闪现顶部内容再跳到底部。
  useLayoutEffect(() => {
    const resetChanged = prevResetKeyRef.current !== resetKey
    prevResetKeyRef.current = resetKey
    if (firstLayoutRef.current || resetChanged) {
      firstLayoutRef.current = false
      forceToBottom()
    }
  }, [resetKey, scrollRef, endRef])

  useEffect(() => {
    const newUserTurn = prevUserIdRef.current !== lastUserId
    prevUserIdRef.current = lastUserId
    if (newUserTurn) {
      forceToBottom()
      return
    }
    scheduleFollow()
  }, [tick, lastUserId, scrollRef, endRef])

  useEffect(() => {
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
      if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current)
    }
  }, [])
}
