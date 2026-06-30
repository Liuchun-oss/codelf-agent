import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { forceX, forceY } from 'd3-force'

type Episode = Awaited<ReturnType<Window['lc']['aiListMemoryGraph']>>['episodes'][number]
type Edge = { src: string; dst: string; weight: number }

const KIND_COLOR: Record<string, string> = {
  identity: '#60a5fa',
  preference: '#a78bfa',
  decision: '#f59e0b',
  convention: '#34d399',
  todo: '#f472b6',
  fact: '#94a3b8',
  note: '#22d3ee',
  dialog: '#cbd5e1'
}

function colorOf(kind: string): string {
  return KIND_COLOR[kind] ?? '#94a3b8'
}

export default function MemoryViewer(props: {
  workspaceRoot: string | null
  onClose?: () => void
}): JSX.Element {
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [loading, setLoading] = useState(false)
  const [scopeFilter, setScopeFilter] = useState<'all' | 'project'>('all')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const ws = scopeFilter === 'project' ? props.workspaceRoot : null
      const res = await window.lc.aiListMemoryGraph(ws, 500)
      setEpisodes(res.episodes)
      setEdges(res.edges)
    } finally {
      setLoading(false)
    }
  }, [props.workspaceRoot, scopeFilter])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="memory-viewer">
      <div className="memory-viewer-toolbar">
        <span className="memory-viewer-title">记忆联想图谱</span>
        <span className="memory-viewer-count">
          {episodes.length} 条记忆 · {edges.length} 条联想
        </span>
        <div style={{ flex: 1 }} />
        <select
          className="memory-viewer-select"
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value as 'all' | 'project')}
        >
          <option value="all">全部记忆</option>
          <option value="project">仅当前项目+全局</option>
        </select>
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load()}>
          {loading ? '加载中…' : '刷新'}
        </button>
        {props.onClose && (
          <button type="button" className="btn-secondary" onClick={props.onClose}>
            关闭
          </button>
        )}
      </div>
      <MemoryGraph episodes={episodes} edges={edges} onChanged={() => void load()} />
    </div>
  )
}

interface GraphNode {
  id: string
  kind: string
  label: string
  full: string
  val: number
  state: string
  x?: number
  y?: number
}

interface GraphLink {
  source: string
  target: string
  weight: number
}

function MemoryGraph(props: {
  episodes: Episode[]
  edges: Edge[]
  onChanged?: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined)
  const fittedRef = useRef(false)
  const [size, setSize] = useState({ w: 760, h: 440 })
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftContent, setDraftContent] = useState('')
  const [draftKind, setDraftKind] = useState('')
  const [busy, setBusy] = useState(false)

  // 容器自适应尺寸（监听父容器变化）。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const data = useMemo(() => {
    const ids = new Set(props.episodes.map((e) => e.id))
    const nodes: GraphNode[] = props.episodes.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: (e.summary || e.content).slice(0, 28),
      full: e.summary || e.content,
      val: 1 + Math.min(10, e.activations * 1.5 + e.strength * 4),
      state: e.state
    }))
    const links: GraphLink[] = props.edges
      .filter((e) => ids.has(e.src) && ids.has(e.dst))
      .map((e) => ({ source: e.src, target: e.dst, weight: e.weight }))
    return { nodes, links }
  }, [props.episodes, props.edges])

  // 数据变化后：配置力学参数（聚拢孤立节点）。fit 交给 onEngineStop（等布局稳定后再缩放居中）。
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || data.nodes.length === 0) return
    fittedRef.current = false
    // 斥力调温和 + 设最大作用距离，避免孤立节点被无限弹开。
    const charge = fg.d3Force('charge')
    if (charge) {
      charge.strength(-60)
      charge.distanceMax(220)
    }
    // 链接距离缩短，让有联想边的记忆抱得更紧。
    const link = fg.d3Force('link')
    if (link) link.distance(40).strength(1)
    // 向心力：把所有节点（含无边的孤立点）温柔地拉回原点（即画布视觉中心）。
    fg.d3Force('center', null)
    fg.d3Force('x', forceX(0).strength(0.06))
    fg.d3Force('y', forceY(0).strength(0.06))
    fg.d3ReheatSimulation()
  }, [data])

  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, scale: number): void => {
      const r = Math.sqrt(node.val) * 2.2
      const active = node.state === 'active'
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2)
      ctx.fillStyle = colorOf(node.kind)
      ctx.globalAlpha = active ? 1 : 0.45
      ctx.fill()
      if (hoverId === node.id) {
        ctx.globalAlpha = 1
        ctx.lineWidth = 2 / scale
        ctx.strokeStyle = '#fff'
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      // 缩放足够大或悬停时显示标签。
      if (scale > 1.4 || hoverId === node.id) {
        const fontSize = Math.max(10 / scale, 3)
        ctx.font = `${fontSize}px sans-serif`
        ctx.fillStyle = 'rgba(226,232,240,0.92)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(node.label, node.x ?? 0, (node.y ?? 0) + r + 1)
      }
    },
    [hoverId]
  )

  if (props.episodes.length === 0) {
    return <div className="debug-panel-empty">暂无记忆可绘制。</div>
  }

  const hoverNode = hoverId ? data.nodes.find((n) => n.id === hoverId) : null
  const selected = selectedId ? props.episodes.find((e) => e.id === selectedId) : null

  const openDetail = (id: string): void => {
    setSelectedId(id)
    setEditing(false)
  }
  const startEdit = (): void => {
    if (!selected) return
    setDraftContent(selected.content)
    setDraftKind(selected.kind)
    setEditing(true)
  }
  const saveEdit = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      await window.lc.aiUpdateMemory({
        id: selected.id,
        content: draftContent,
        summary: draftContent.slice(0, 60),
        kind: draftKind
      })
      setEditing(false)
      props.onChanged?.()
    } finally {
      setBusy(false)
    }
  }
  const removeMemory = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      await window.lc.aiDeleteMemory(selected.id)
      setSelectedId(null)
      props.onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="memory-graph-wrap" ref={wrapRef}>
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={4}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as GraphNode
          const r = Math.sqrt(n.val) * 2.2 + 3
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2)
          ctx.fill()
        }}
        onNodeHover={(node) => setHoverId(node ? (node as GraphNode).id : null)}
        onNodeClick={(node) => openDetail((node as GraphNode).id)}
        onBackgroundClick={() => setSelectedId(null)}
        onEngineStop={() => {
          // 布局稳定后再缩放居中，且只在每批数据首次稳定时执行（避免拖拽后强行拉回视野）。
          if (!fittedRef.current) {
            fittedRef.current = true
            fgRef.current?.zoomToFit(400, 50)
          }
        }}
        linkColor={() => 'rgba(148,163,184,0.22)'}
        linkWidth={(l) => Math.min(2.5, 0.6 + (l as GraphLink).weight * 0.4)}
        linkDirectionalParticles={0}
        cooldownTicks={120}
        d3VelocityDecay={0.3}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
      />
      {hoverNode && !selected && <div className="memory-graph-tip">{hoverNode.full}</div>}
      <div className="memory-graph-legend">
        点击节点查看/编辑 · 拖动重排 · 滚轮缩放 · 拖空白处平移；节点大小=活跃度，颜色=类型，半透明=休眠
      </div>
      {selected && (
        <div className="memory-detail-panel">
          <div className="memory-detail-head">
            <span className="memory-kind-dot" style={{ background: colorOf(selected.kind) }} />
            {editing ? (
              <select
                className="memory-viewer-select"
                value={draftKind}
                onChange={(e) => setDraftKind(e.target.value)}
              >
                {Object.keys(KIND_COLOR).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <span className="memory-detail-kind">{selected.kind}</span>
            )}
            <span className="memory-detail-scope">{selected.scope}</span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="memory-detail-close"
              onClick={() => setSelectedId(null)}
              title="关闭"
            >
              ✕
            </button>
          </div>
          {editing ? (
            <textarea
              className="memory-detail-textarea"
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={5}
            />
          ) : (
            <div className="memory-detail-content">{selected.content}</div>
          )}
          <div className="memory-detail-meta">
            <span>显著 {selected.salience.toFixed(2)}</span>
            <span>激活 {selected.activations}</span>
            <span>强度 {Math.round(selected.strength * 100)}%</span>
            <span>{new Date(selected.createdAt).toLocaleDateString('zh-CN')}</span>
          </div>
          <div className="memory-detail-actions">
            {editing ? (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !draftContent.trim()}
                  onClick={() => void saveEdit()}
                >
                  保存
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="memory-detail-danger"
                  disabled={busy}
                  onClick={() => void removeMemory()}
                >
                  删除
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={startEdit}>
                  编辑
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}


