import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeBase, KnowledgeDoc, KnowledgeHit, KnowledgeProgress, KnowledgeImportResult, KnowledgeHealthCheck, KnowledgeOutdatedDoc, KnowledgePreviewFile } from '@/types'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useUiStore } from '@/stores/uiStore'
import { basename } from '@/utils/path'

function docExt(path: string): string {
  const m = path.match(/\.([^.\\/]+)$/)
  return m ? m[1].toLowerCase() : 'txt'
}

interface Props {
  /** 侧边栏模式显示更多操作；设置页模式更紧凑 */
  variant?: 'sidebar' | 'settings'
}

export default function KnowledgeManager({ variant = 'sidebar' }: Props): JSX.Element {
  const [probe, setProbe] = useState<{ ok: boolean; error?: string } | null>(null)
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [activeKb, setActiveKb] = useState<string | null>(null)
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [newKbName, setNewKbName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<KnowledgeProgress | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<KnowledgeHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [minScore, setMinScore] = useState(0.3) // 相关度下限，默认 0.3
  const [importResult, setImportResult] = useState<KnowledgeImportResult | null>(null)
  const [showFailedDetails, setShowFailedDetails] = useState(false)
  const [healthCheck, setHealthCheck] = useState<KnowledgeHealthCheck | null>(null)
  const [showHealthCheck, setShowHealthCheck] = useState(false)
  const [outdatedDocs, setOutdatedDocs] = useState<KnowledgeOutdatedDoc[]>([])
  const [showOutdated, setShowOutdated] = useState(false)
  const [previewFiles, setPreviewFiles] = useState<KnowledgePreviewFile[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const activeKbRef = useRef<string | null>(null)
  activeKbRef.current = activeKb

  const activeMeta = kbs.find((k) => k.id === activeKb) ?? null

  const refreshKbs = useCallback(async (): Promise<void> => {
    const res = await window.lc.knowledge.listKbs()
    if (res.ok) {
      setKbs(res.kbs)
      setActiveKb((cur) => cur ?? (res.kbs.length > 0 ? res.kbs[0].id : null))
    }
  }, [])

  const refreshDocs = useCallback(async (kbId: string | null): Promise<void> => {
    if (!kbId) {
      setDocs([])
      return
    }
    const res = await window.lc.knowledge.listDocs(kbId)
    if (res.ok) setDocs(res.docs)
  }, [])

  useEffect(() => {
    void (async () => {
      const p = await window.lc.knowledge.probe()
      setProbe(p)
      if (p.ok) await refreshKbs()
    })()
  }, [refreshKbs])

  useEffect(() => {
    void refreshDocs(activeKb)
    setSearchHits([])
    setSearchError(null)
  }, [activeKb, refreshDocs])

  useEffect(() => {
    const off = window.lc.knowledge.onProgress((p) => {
      setProgress(p)
      useKnowledgeStore.getState().setProgress(p)
      if (p.phase === 'done' || p.phase === 'error') {
        setBusy(false)
        void refreshKbs()
        void refreshDocs(activeKbRef.current)
        // 完成后获取导入结果（包含失败详情）
        void window.lc.knowledge.status().then((s) => {
          if (s.lastResult) setImportResult(s.lastResult)
        })
      }
    })
    return off
  }, [refreshKbs, refreshDocs])

  const createKb = async (): Promise<void> => {
    const name = newKbName.trim()
    if (!name) return
    const res = await window.lc.knowledge.createKb(name)
    if (res.ok && res.id) {
      setNewKbName('')
      await refreshKbs()
      setActiveKb(res.id)
    }
  }

  const deleteKb = async (kbId: string): Promise<void> => {
    const ok = window.confirm('确定删除此知识库及其全部文档与向量？')
    if (!ok) return
    await window.lc.knowledge.deleteKb(kbId)
    if (activeKb === kbId) setActiveKb(null)
    await refreshKbs()
  }

  const rebuildKb = async (kbId: string): Promise<void> => {
    const ok = window.confirm(
      '重建知识库将清空所有向量并重新解析、向量化所有文档。这可能需要较长时间。确定继续？'
    )
    if (!ok) return
    setBusy(true)
    setProgress(null)
    useKnowledgeStore.getState().reset()
    const res = await window.lc.knowledge.rebuild(kbId)
    if (!res.ok) {
      setBusy(false)
      const err: KnowledgeProgress = {
        phase: 'error',
        filesTotal: 0,
        filesProcessed: 0,
        chunksEmbedded: 0,
        error: res.error
      }
      setProgress(err)
      useKnowledgeStore.getState().setProgress(err)
    }
  }

  const exportKb = async (kbId: string): Promise<void> => {
    const result = await window.lc.knowledge.export(kbId)
    if (result.ok) {
      window.alert(`导出成功：${result.path}`)
    } else if (result.error !== '已取消') {
      window.alert(`导出失败：${result.error}`)
    }
  }

  const importFromExport = async (kbId: string): Promise<void> => {
    const result = await window.lc.knowledge.importFromExport(kbId)
    if (!result.ok) {
      if (result.error !== '已取消') {
        window.alert(`导入失败：${result.error}`)
      }
      return
    }

    const { existing = [], missing = [], totalDocs = 0 } = result

    if (missing.length > 0) {
      const msg = `找到 ${totalDocs} 个文档：\n\n✅ ${existing.length} 个文件存在\n❌ ${missing.length} 个文件缺失\n\n缺失文件：\n${missing.slice(0, 5).map(p => `  - ${p}`).join('\n')}${missing.length > 5 ? `\n  ... 还有 ${missing.length - 5} 个` : ''}\n\n是否导入存在的 ${existing.length} 个文件？`

      const confirmed = window.confirm(msg)
      if (!confirmed) return
    }

    if (existing.length === 0) {
      window.alert('所有文档文件都不存在，无法导入。\n\n请确保原始文档文件与导出时路径一致。')
      return
    }

    // 开始导入
    setBusy(true)
    setProgress(null)
    useKnowledgeStore.getState().reset()
    const importRes = await window.lc.knowledge.import(kbId, existing)
    if (!importRes.ok) {
      setBusy(false)
      const err: KnowledgeProgress = {
        phase: 'error',
        filesTotal: 0,
        filesProcessed: 0,
        chunksEmbedded: 0,
        error: importRes.error
      }
      setProgress(err)
      useKnowledgeStore.getState().setProgress(err)
    }
  }

  const checkOutdated = async (kbId: string): Promise<void> => {
    const result = await window.lc.knowledge.findOutdated(kbId)
    if (result.ok) {
      setOutdatedDocs(result.outdated)
      if (result.outdated.length > 0) {
        setShowOutdated(true)
      } else {
        window.alert('所有文档均为最新版本。')
      }
    } else {
      window.alert(`检测失败：${result.error}`)
    }
  }

  const reimportOutdated = async (): Promise<void> => {
    if (outdatedDocs.length === 0 || !activeKb) return
    const paths = outdatedDocs.filter(d => d.reason === 'modified').map(d => d.path)
    if (paths.length === 0) {
      window.alert('没有可重新导入的文档（全部已删除）。')
      return
    }
    setShowOutdated(false)
    setBusy(true)
    setProgress(null)
    useKnowledgeStore.getState().reset()
    const res = await window.lc.knowledge.import(activeKb, paths)
    if (!res.ok) {
      setBusy(false)
      const err: KnowledgeProgress = {
        phase: 'error',
        filesTotal: 0,
        filesProcessed: 0,
        chunksEmbedded: 0,
        error: res.error
      }
      setProgress(err)
      useKnowledgeStore.getState().setProgress(err)
    }
  }

  const importFiles = async (mode: 'files' | 'folder'): Promise<void> => {
    if (!activeKb) return
    const paths =
      mode === 'files'
        ? await window.lc.knowledge.pickDocs()
        : await window.lc.knowledge.pickFolder().then((p) => (p ? [p] : null))
    if (!paths || paths.length === 0) return

    // 先预览扫描
    const preview = await window.lc.knowledge.preview(activeKb, paths)
    if (!preview.ok) {
      window.alert(`预览失败：${preview.error}`)
      return
    }

    // 如果有可导入的文件，显示预览面板让用户选择
    const importable = preview.files.filter(f => ['new', 'updated'].includes(f.status))
    if (importable.length === 0) {
      // 统计各种状态的文件数
      const unchanged = preview.files.filter(f => f.status === 'unchanged').length
      const unsupported = preview.files.filter(f => f.status === 'unsupported').length
      const oversized = preview.files.filter(f => f.status === 'oversized').length
      const empty = preview.files.filter(f => f.status === 'empty').length

      const reasons: string[] = []
      if (unchanged > 0) reasons.push(`${unchanged} 个文件未变更`)
      if (unsupported > 0) reasons.push(`${unsupported} 个文件格式不支持`)
      if (oversized > 0) reasons.push(`${oversized} 个文件过大 (>20MB)`)
      if (empty > 0) reasons.push(`${empty} 个文件为空`)

      window.alert(`没有需要导入的文件：\n\n${reasons.join('\n')}`)
      return
    }

    setPreviewFiles(preview.files)
    setSelectedPaths(new Set(importable.map(f => f.path)))
    setShowPreview(true)
  }

  const confirmImport = async (): Promise<void> => {
    if (!activeKb || selectedPaths.size === 0) return
    const paths = Array.from(selectedPaths)
    setShowPreview(false)
    setBusy(true)
    setProgress(null)
    useKnowledgeStore.getState().reset()
    const res = await window.lc.knowledge.import(activeKb, paths)
    if (!res.ok) {
      setBusy(false)
      const err: KnowledgeProgress = {
        phase: 'error',
        filesTotal: 0,
        filesProcessed: 0,
        chunksEmbedded: 0,
        error: res.error
      }
      setProgress(err)
      useKnowledgeStore.getState().setProgress(err)
    }
  }

  const removeDoc = async (docId: string): Promise<void> => {
    await window.lc.knowledge.removeDoc(docId)
    await refreshDocs(activeKb)
    await refreshKbs()
  }

  const runSearch = async (): Promise<void> => {
    if (!activeKb || !searchQuery.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await window.lc.knowledge.query(activeKb, searchQuery.trim(), 10)
      if (!res.ok) {
        setSearchError(res.error ?? '检索失败')
        setSearchHits([])
      } else {
        // 前端再过滤一次相关度，只显示 >= minScore 的结果
        const filtered = res.hits.filter((h) => h.score >= minScore)
        setSearchHits(filtered)
        if (filtered.length === 0 && res.hits.length > 0) {
          setSearchError(`找到 ${res.hits.length} 个结果，但相关度均低于 ${minScore.toFixed(2)}`)
        }
      }
    } finally {
      setSearching(false)
    }
  }

  const openRagSettings = (): void => {
    useUiStore.getState().setShowSettings(true)
    // SettingsPanel 默认 ai；用户需点 Agent 行为。侧边栏用 tooltip 说明即可。
  }

  const runHealthCheck = async (kbId: string): Promise<void> => {
    const result = await window.lc.knowledge.healthCheck(kbId)
    setHealthCheck(result)
    setShowHealthCheck(true)
  }

  const runRepair = async (kbId: string): Promise<void> => {
    const ok = window.confirm('修复将清理孤儿数据并修正计数。确定继续？')
    if (!ok) return
    const result = await window.lc.knowledge.repair(kbId)
    if (result.ok) {
      window.alert(`修复完成，共修复 ${result.fixed} 项问题。`)
      setShowHealthCheck(false)
      setHealthCheck(null)
      await refreshKbs()
    } else {
      window.alert(`修复失败：${result.error}`)
    }
  }

  const phaseLabel = (p: KnowledgeProgress): string => {
    if (p.phase === 'scanning') return '扫描中'
    if (p.phase === 'parsing') return '解析中'
    if (p.phase === 'embedding') return '向量化中'
    if (p.phase === 'done') return p.error ? `失败：${p.error}` : '完成'
    if (p.phase === 'error') return `错误：${p.error}`
    return '...'
  }

  const statusLabel = (status: KnowledgePreviewFile['status']): string => {
    switch (status) {
      case 'new': return '新文档'
      case 'unchanged': return '未变更'
      case 'updated': return '已更新'
      case 'oversized': return '文件过大'
      case 'empty': return '文件为空'
      case 'unsupported': return '不支持'
      default: return status
    }
  }

  if (probe && !probe.ok) {
    return (
      <div className="knowledge-probe-error">
        <p>向量数据库未能加载。</p>
        <small>{probe.error}</small>
      </div>
    )
  }

  if (probe === null) {
    return <div className="knowledge-empty-hint">加载中…</div>
  }

  const pct =
    progress && progress.filesTotal > 0
      ? Math.min(100, Math.round((progress.filesProcessed / progress.filesTotal) * 100))
      : 0

  return (
    <div className={`knowledge-manager${variant === 'settings' ? ' knowledge-manager--settings' : ''}`}>
      <div className="knowledge-create-row">
        <input
          type="text"
          className="knowledge-input"
          placeholder="新建知识库名称"
          value={newKbName}
          disabled={busy}
          onChange={(e) => setNewKbName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createKb()
          }}
        />
        <button type="button" className="btn knowledge-btn-sm" disabled={!newKbName.trim() || busy} onClick={() => void createKb()}>
          创建
        </button>
      </div>

      {kbs.length === 0 ? (
        <div className="knowledge-empty-hint">暂无知识库。输入名称创建后，导入 docx / pdf / doc / xls / xlsx / md / txt。</div>
      ) : (
        <>
          <div className="knowledge-kb-row">
            <select
              className="knowledge-select"
              value={activeKb ?? ''}
              disabled={busy}
              onChange={(e) => setActiveKb(e.target.value || null)}
            >
              {kbs.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}
                </option>
              ))}
            </select>
            {activeMeta && (
              <span className="knowledge-stats">
                {activeMeta.docCount} 篇 · {activeMeta.chunkCount} 块
              </span>
            )}
          </div>

          <div className="knowledge-toolbar">
            <button type="button" className="knowledge-tool-btn" disabled={!activeKb || busy} onClick={() => void importFiles('files')}>
              导入文件
            </button>
            <button type="button" className="knowledge-tool-btn" disabled={!activeKb || busy} onClick={() => void importFiles('folder')}>
              导入文件夹
            </button>
            {busy && (
              <button type="button" className="knowledge-tool-btn" onClick={() => void window.lc.knowledge.cancel()}>
                取消
              </button>
            )}
            {variant === 'sidebar' && (
              <button type="button" className="knowledge-tool-btn" title="Agent 自动注入设置（设置 → Agent 行为）" onClick={openRagSettings}>
                RAG 设置
              </button>
            )}
            <button
              type="button"
              className="knowledge-tool-btn"
              disabled={!activeKb || busy}
              title="检查知识库完整性与一致性问题"
              onClick={() => activeKb && void runHealthCheck(activeKb)}
            >
              健康检查
            </button>
            <button
              type="button"
              className="knowledge-tool-btn"
              disabled={!activeKb || busy || (activeMeta?.docCount ?? 0) === 0}
              title="检查哪些文档文件已变更或删除"
              onClick={() => activeKb && void checkOutdated(activeKb)}
            >
              检查更新
            </button>
            <button
              type="button"
              className="knowledge-tool-btn"
              disabled={!activeKb || busy || (activeMeta?.docCount ?? 0) === 0}
              title="清空向量并重新解析、向量化所有文档"
              onClick={() => activeKb && void rebuildKb(activeKb)}
            >
              重建索引
            </button>
            <button
              type="button"
              className="knowledge-tool-btn"
              disabled={!activeKb || busy}
              title="导出知识库元数据到 JSON 文件（不含向量）"
              onClick={() => activeKb && void exportKb(activeKb)}
            >
              导出
            </button>
            <button
              type="button"
              className="knowledge-tool-btn"
              disabled={!activeKb || busy}
              title="从导出的 JSON 文件导入文档"
              onClick={() => activeKb && void importFromExport(activeKb)}
            >
              从导出导入
            </button>
            <button
              type="button"
              className="knowledge-tool-btn danger"
              disabled={!activeKb || busy}
              onClick={() => activeKb && void deleteKb(activeKb)}
            >
              删除库
            </button>
          </div>

          {progress && (
            <div className={`knowledge-progress${progress.phase === 'error' ? ' is-error' : ''}`}>
              <div className="knowledge-progress-label">
                {phaseLabel(progress)}
                {progress.phase !== 'done' && progress.phase !== 'error' && progress.filesTotal > 0
                  ? ` · ${progress.filesProcessed}/${progress.filesTotal} · ${progress.chunksEmbedded} 块`
                  : ''}
                {progress.phase === 'done' && importResult && importResult.failed > 0 && (
                  <button
                    type="button"
                    className="knowledge-show-failed-btn"
                    onClick={() => setShowFailedDetails(!showFailedDetails)}
                    title="查看失败文件详情"
                  >
                    {importResult.failed} 个失败 {showFailedDetails ? '▼' : '▶'}
                  </button>
                )}
              </div>
              {progress.currentFile && progress.phase !== 'done' && progress.phase !== 'error' && (
                <div className="knowledge-progress-file" title={progress.currentFile}>
                  {basename(progress.currentFile)}
                </div>
              )}
              {progress.warnings && progress.warnings.length > 0 && (
                <div className="knowledge-warnings">
                  {progress.warnings.map((w, i) => (
                    <div key={i} className="knowledge-warning-item">
                      <strong>{basename(w.path)}:</strong> {w.message}
                    </div>
                  ))}
                </div>
              )}
              {showFailedDetails && importResult?.failedFiles && (
                <div className="knowledge-failed-details">
                  {importResult.failedFiles.map((f, i) => (
                    <div key={i} className="knowledge-failed-item">
                      <div className="knowledge-failed-path" title={f.path}>
                        {basename(f.path)}
                      </div>
                      <div className="knowledge-failed-reason">{f.reason}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="knowledge-progress-bar">
                <span
                  className="knowledge-progress-fill"
                  style={{ width: progress.phase === 'done' ? '100%' : `${pct}%` }}
                />
              </div>
            </div>
          )}

          {showHealthCheck && healthCheck && (
            <div className={`knowledge-health-check${healthCheck.ok ? ' is-ok' : ' is-warning'}`}>
              <div className="knowledge-health-header">
                {healthCheck.ok ? '✓ 知识库健康' : '⚠ 发现问题'}
                <button type="button" className="knowledge-close-btn" onClick={() => setShowHealthCheck(false)}>
                  ×
                </button>
              </div>
              {!healthCheck.ok && (
                <>
                  <ul className="knowledge-health-issues">
                    {healthCheck.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="knowledge-tool-btn"
                    onClick={() => activeKb && void runRepair(activeKb)}
                  >
                    立即修复
                  </button>
                </>
              )}
            </div>
          )}

          {showOutdated && outdatedDocs.length > 0 && (
            <div className="knowledge-outdated-panel">
              <div className="knowledge-health-header">
                ⚠ {outdatedDocs.length} 个文档已过期
                <button type="button" className="knowledge-close-btn" onClick={() => setShowOutdated(false)}>
                  ×
                </button>
              </div>
              <ul className="knowledge-outdated-list">
                {outdatedDocs.map((doc) => (
                  <li key={doc.id} className="knowledge-outdated-item">
                    <div className="knowledge-outdated-title">{doc.title}</div>
                    <div className="knowledge-outdated-reason">
                      {doc.reason === 'modified' ? '文件已修改' : '文件已删除'}
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="knowledge-tool-btn"
                disabled={outdatedDocs.filter(d => d.reason === 'modified').length === 0}
                onClick={() => void reimportOutdated()}
              >
                重新导入已修改的文档
              </button>
            </div>
          )}

          {showPreview && previewFiles.length > 0 && (
            <div className="knowledge-preview-panel">
              <div className="knowledge-health-header">
                导入预览 ({selectedPaths.size}/{previewFiles.filter(f => ['new', 'updated'].includes(f.status)).length} 个)
                <button type="button" className="knowledge-close-btn" onClick={() => setShowPreview(false)}>
                  ×
                </button>
              </div>
              <div className="knowledge-preview-controls">
                <button
                  type="button"
                  className="knowledge-tool-btn"
                  onClick={() => {
                    const importable = previewFiles.filter(f => ['new', 'updated'].includes(f.status))
                    setSelectedPaths(new Set(importable.map(f => f.path)))
                  }}
                >
                  全选
                </button>
                <button type="button" className="knowledge-tool-btn" onClick={() => setSelectedPaths(new Set())}>
                  全不选
                </button>
              </div>
              <ul className="knowledge-preview-list">
                {previewFiles.map((file, i) => {
                  const canSelect = ['new', 'updated'].includes(file.status)
                  const selected = selectedPaths.has(file.path)
                  return (
                    <li key={i} className={`knowledge-preview-item status-${file.status}`}>
                      {canSelect && (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(e) => {
                            const next = new Set(selectedPaths)
                            if (e.target.checked) next.add(file.path)
                            else next.delete(file.path)
                            setSelectedPaths(next)
                          }}
                        />
                      )}
                      <div className="knowledge-preview-info">
                        <div className="knowledge-preview-path" title={file.path}>
                          {basename(file.path)}
                        </div>
                        <div className="knowledge-preview-meta">
                          {Math.round(file.size / 1024)}KB · {statusLabel(file.status)}
                          {file.reason && ` (${file.reason})`}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <button
                type="button"
                className="knowledge-tool-btn"
                disabled={selectedPaths.size === 0}
                onClick={() => void confirmImport()}
              >
                确认导入 ({selectedPaths.size} 个)
              </button>
            </div>
          )}

          {variant === 'sidebar' && activeKb && (
            <div className="knowledge-search-box">
              <input
                className="knowledge-input"
                placeholder="试检索：输入问题或关键词"
                value={searchQuery}
                disabled={searching}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
              />
              <div className="knowledge-search-controls">
                <label className="knowledge-min-score-label">
                  相关度 ≥
                  <input
                    type="number"
                    className="knowledge-min-score-input"
                    min="0"
                    max="1"
                    step="0.05"
                    value={minScore}
                    onChange={(e) => setMinScore(Math.max(0, Math.min(1, parseFloat(e.target.value) || 0.3)))}
                  />
                </label>
                <button type="button" className="knowledge-tool-btn" disabled={searching || !searchQuery.trim()} onClick={() => void runSearch()}>
                  {searching ? '…' : '检索'}
                </button>
              </div>
              {searchError && <div className="knowledge-search-error">{searchError}</div>}
              {searchHits.length > 0 && (
                <ul className="knowledge-hit-list">
                  {searchHits.map((hit, i) => (
                    <li key={`${hit.docId}-${hit.ordinal}-${i}`} className="knowledge-hit-row">
                      <div className="knowledge-hit-title">
                        {hit.heading ? `${hit.title} › ${hit.heading}` : hit.title}
                        <span className={`knowledge-hit-score${hit.score >= 0.6 ? ' is-high' : hit.score >= 0.4 ? ' is-medium' : ''}`}>
                          {hit.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="knowledge-hit-path" title={hit.path}>
                        {hit.path}
                      </div>
                      <div className="knowledge-hit-preview">{hit.text.slice(0, 200)}{hit.text.length > 200 ? '…' : ''}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="knowledge-doc-list">
            {docs.length === 0 ? (
              <div className="knowledge-empty-hint">暂无文档，点击上方导入。</div>
            ) : (
              docs.map((doc) => (
                <div key={doc.id} className="knowledge-doc-row">
                  <span className={`knowledge-badge knowledge-badge-${docExt(doc.path)}`}>{docExt(doc.path)}</span>
                  <div className="knowledge-doc-main">
                    <div className="knowledge-doc-title" title={doc.title}>
                      {doc.title}
                    </div>
                    <div className="knowledge-doc-path" title={doc.path}>
                      {doc.path}
                    </div>
                  </div>
                  <span className="knowledge-doc-chunks">{doc.chunkCount}</span>
                  <button type="button" className="knowledge-doc-remove" title="移除此文档" onClick={() => void removeDoc(doc.id)}>
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
