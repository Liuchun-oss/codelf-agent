import { useCallback, useMemo, useState } from 'react'
import {
  detectSlashCommand,
  removeSlashCommand,
  buildForcedInstruction,
  type SlashReference
} from './slashCommand'
import type { SlashItem } from './SlashPicker'

export interface UseSlashRefsResult {
  /** 已选引用列表 */
  slashRefs: SlashReference[]
  /** 当前检测到的 / 命令（决定是否展示面板） */
  slashCommand: ReturnType<typeof detectSlashCommand>
  /** 是否展示斜线面板（命令存在且非流式时） */
  showSlashPicker: boolean
  slashQuery: string
  slashActive: number
  setSlashActive: React.Dispatch<React.SetStateAction<number>>
  slashPickSignal: number
  slashRowCount: number
  setSlashRowCount: (n: number) => void
  /** 选中一项：从输入里删掉 /query 并加入引用 */
  applySlashPick: (item: SlashItem, opts: ApplyPickOptions) => void
  /** 移除一条引用（id 形如 kind:name） */
  removeSlashRef: (id: string) => void
  /** 清空全部引用（发送后调用） */
  clearSlashRefs: () => void
  /** 处理面板内的键盘事件，返回 true 表示已消费（调用方应 return） */
  handleSlashKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, opts: KeyDownOptions) => boolean
  /** 把强制指令前置到正文，返回最终要发送的文本 */
  composeMessage: (text: string) => string
}

interface ApplyPickOptions {
  input: string
  setInput: (v: string) => void
  setCursor: (n: number) => void
  textareaRef: React.RefObject<HTMLTextAreaElement>
}

interface KeyDownOptions {
  input: string
  setInput: (v: string) => void
  setCursor: (n: number) => void
}

export function useSlashRefs(input: string, cursor: number, streaming: boolean): UseSlashRefsResult {
  const [slashRefs, setSlashRefs] = useState<SlashReference[]>([])
  const [slashActive, setSlashActive] = useState(0)
  const [slashPickSignal, setSlashPickSignal] = useState(0)
  const [slashRowCount, setSlashRowCount] = useState(0)

  const slashCommand = useMemo(() => detectSlashCommand(input, cursor), [input, cursor])
  const showSlashPicker = !!slashCommand && !streaming

  const applySlashPick = useCallback(
    (item: SlashItem, opts: ApplyPickOptions): void => {
      const cmd = detectSlashCommand(opts.input, opts.textareaRef.current?.selectionStart ?? opts.input.length)
      if (cmd) {
        const { text, cursor: nextCur } = removeSlashCommand(opts.input, cmd)
        opts.setInput(text)
        requestAnimationFrame(() => {
          const el = opts.textareaRef.current
          if (el) {
            el.focus()
            el.setSelectionRange(nextCur, nextCur)
            opts.setCursor(nextCur)
          }
        })
      }
      // 动作型指令（如 /compact）为立即执行型，不产生引用；此 hook 只处理引用型。
      if (item.kind === 'action') return
      const ref: SlashReference = {
        kind: item.kind === 'plugin' ? 'plugin' : 'skill',
        name: item.name,
        pluginSkills: item.pluginSkills,
        pluginMcpServers: item.pluginMcpServers
      }
      setSlashRefs((prev) => {
        if (prev.some((r) => r.kind === ref.kind && r.name === ref.name)) return prev
        return [...prev, ref]
      })
    },
    []
  )

  const removeSlashRef = useCallback((id: string): void => {
    setSlashRefs((prev) => prev.filter((r) => `${r.kind}:${r.name}` !== id))
  }, [])

  const clearSlashRefs = useCallback((): void => setSlashRefs([]), [])

  const handleSlashKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, opts: KeyDownOptions): boolean => {
      if (!showSlashPicker) return false
      if (e.key === 'Escape') {
        e.preventDefault()
        if (slashCommand) {
          const { text, cursor: nextCur } = removeSlashCommand(opts.input, slashCommand)
          opts.setInput(text)
          opts.setCursor(nextCur)
        }
        return true
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => (slashRowCount > 0 ? Math.min(i + 1, slashRowCount - 1) : 0))
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => Math.max(0, i - 1))
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        setSlashPickSignal((n) => n + 1)
        return true
      }
      return false
    },
    [showSlashPicker, slashCommand, slashRowCount]
  )

  const composeMessage = useCallback(
    (text: string): string => {
      const forced = buildForcedInstruction(slashRefs)
      if (!forced) return text
      return text ? `${forced}\n\n${text}` : forced
    },
    [slashRefs]
  )

  return {
    slashRefs,
    slashCommand,
    showSlashPicker,
    slashQuery: slashCommand?.query ?? '',
    slashActive,
    setSlashActive,
    slashPickSignal,
    slashRowCount,
    setSlashRowCount,
    applySlashPick,
    removeSlashRef,
    clearSlashRefs,
    handleSlashKeyDown,
    composeMessage
  }
}
