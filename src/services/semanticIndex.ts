import { useSemanticIndexStore } from '@/stores/semanticIndexStore'
import { useDialogStore } from '@/stores/dialogStore'

// 语义索引前端控制器：监听工作区切换触发构建，文件变更触发增量更新。
let currentRoot: string | null = null
let updateTimer: ReturnType<typeof setTimeout> | null = null
const pendingPaths = new Set<string>()

// 记录用户对各工作区“首次询问”的处置，避免反复弹窗（仅当前会话内存级）。
const declinedRoots = new Set<string>()

function buildConsentMessage(fileCount: number, autoLimit: number): string {
  const lines = [
    '是否为当前工作区建立「代码语义索引」？',
    '',
    '✓ 作用',
    '让 AI 用自然语言或概念搜索代码，例如搜“登录在哪处理”也能定位到 verifyToken，检索更准、更省往返。',
    '',
    '• 代价',
    `首次需在后台对约 ${fileCount} 个文件计算向量，会占用一些 CPU。计算放在独立进程，不会卡界面；完成后保存到本地，之后仅增量更新。`
  ]
  if (fileCount > autoLimit) {
    lines.push('', `⚠ 该工作区文件较多（超过 ${autoLimit} 个），首次构建耗时会更长。`)
  }
  lines.push(
    '',
    '不建立也能正常使用，AI 会回退到关键词搜索。',
    '之后可在「文件 → 建立 / 更新代码索引」里随时手动建立。'
  )
  return lines.join('\n')
}

// 工作区切换时调用：已有索引则静默增量；无索引则弹窗询问用户。
export function onWorkspaceChanged(root: string | null): void {
  if (root === currentRoot) return
  currentRoot = root
  useSemanticIndexStore.getState().reset()
  if (!root) return

  void window.lc.semantic
    .count(root)
    .then(async ({ fileCount, indexed, autoLimit }) => {
      if (root !== currentRoot) return
      // 已有索引：直接增量复用，无需打扰用户。
      if (indexed) {
        void window.lc.semantic.build(root).catch(() => {})
        return
      }
      // 本会话内用户已拒绝过该工作区，则不再弹窗，仅在状态栏留手动入口。
      if (declinedRoots.has(root)) {
        useSemanticIndexStore.getState().setNeedsManual(fileCount)
        return
      }
      if (fileCount === 0) return

      const ok = await useDialogStore.getState().confirm({
        title: '建立代码语义索引',
        message: buildConsentMessage(fileCount, autoLimit),
        confirmText: '建立索引',
        cancelText: '暂不'
      })
      if (root !== currentRoot) return
      if (ok) {
        void window.lc.semantic.build(root).catch(() => {})
      } else {
        declinedRoots.add(root)
        useSemanticIndexStore.getState().setNeedsManual(fileCount)
      }
    })
    .catch(() => {
      // 估算失败不打扰用户。
    })
}

// 用户手动触发构建/重建（状态栏提示或菜单）。
export function triggerManualBuild(): void {
  if (!currentRoot) return
  declinedRoots.delete(currentRoot)
  useSemanticIndexStore.getState().clearNeedsManual()
  void window.lc.semantic.build(currentRoot).catch(() => {})
}

// 是否有打开的工作区（供命令的 enabled 判断）。
export function hasIndexableWorkspace(): boolean {
  return !!currentRoot
}

// 文件变更时调用：去抖后增量更新这些文件的向量。
export function onFilesChanged(paths: string[]): void {
  if (!currentRoot || paths.length === 0) return
  for (const p of paths) pendingPaths.add(p)
  if (updateTimer) clearTimeout(updateTimer)
  updateTimer = setTimeout(() => {
    const root = currentRoot
    if (!root) return
    const batch = [...pendingPaths]
    pendingPaths.clear()
    void window.lc.semantic.update(root, batch).catch(() => {})
  }, 1500)
}
