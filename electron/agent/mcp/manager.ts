import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpConnectionStatus,
  McpPromptSummary,
  McpResourceSummary,
  McpServerConfig,
  McpToolSummary
} from '@shared/mcpTypes'
import { isStdioConfig, transportTypeOf } from '@shared/mcpTypes'
import type { ResolvedMcpServer } from './config'
import { resolveMcpServers } from './config'
import { MCP_CLIENT_NAME, APP_VERSION } from '@shared/appConfig'
import { buildMcpToolName } from './naming'
import { transformToolResult, transformResourceResult, transformPromptResult } from './resultTransform'

const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000

export interface McpDiscoveredTool {
  qualifiedName: string
  originalName: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  destructive: boolean
}

interface DiscoveredResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

interface DiscoveredPrompt {
  name: string
  description?: string
}

interface ServerConnection {
  name: string
  config: McpServerConfig
  scope: ResolvedMcpServer['scope']
  enabled: boolean
  approval?: 'approved' | 'rejected'
  status: McpConnectionStatus
  client?: Client
  transport?: Transport
  error?: string
  serverInfo?: { name: string; version: string }
  tools: McpDiscoveredTool[]
  resources: DiscoveredResource[]
  prompts: DiscoveredPrompt[]
  capabilities?: { resources?: boolean; prompts?: boolean }
}

type ChangeListener = () => void

function createTransport(config: McpServerConfig): Transport {
  if (isStdioConfig(config)) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: 'pipe'
    })
  }
  const url = new URL(config.url)
  const requestInit = config.headers ? { headers: config.headers } : undefined
  if (config.type === 'sse') {
    return new SSEClientTransport(url, { requestInit })
  }
  return new StreamableHTTPClientTransport(url, { requestInit })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

class McpManager {
  private connections = new Map<string, ServerConnection>()
  private workspaceRoot: string | null = null
  private loadedRoot = false
  private listeners = new Set<ChangeListener>()
  private initializing: Promise<void> | null = null

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // 忽略监听器异常
      }
    }
  }

  // 确保已按当前工作区连接所有启用的 server（首次调用时连接）。
  async ensureConnected(workspaceRoot: string | null): Promise<void> {
    if (this.initializing) {
      await this.initializing
      return
    }
    // 工作区切换，或从未加载过，才重新连接；
    // 空配置（0 个 server）也视为已加载，避免每轮重复读盘重连。
    if (this.workspaceRoot !== workspaceRoot || !this.loadedRoot) {
      await this.reloadAll(workspaceRoot)
    }
  }

  // 重新读取配置并重连所有 server。
  async reloadAll(workspaceRoot: string | null): Promise<void> {
    this.workspaceRoot = workspaceRoot
    const run = (async () => {
      await this.disconnectAll()
      const servers = resolveMcpServers(workspaceRoot)
      await Promise.all(servers.map((s) => this.connectOne(s)))
    })()
    this.initializing = run
    try {
      await run
      this.loadedRoot = true
    } finally {
      this.initializing = null
    }
    this.emitChange()
  }

  private async connectOne(server: ResolvedMcpServer): Promise<void> {
    // 项目级 server 未审批（pending）时不连接，等待用户批准。
    const isPendingProject = server.scope === 'project' && server.approval === undefined
    const isRejected = server.scope === 'project' && server.approval === 'rejected'
    const status: McpConnectionStatus = isPendingProject
      ? 'pending'
      : isRejected || !server.enabled
        ? 'disabled'
        : 'connecting'
    const conn: ServerConnection = {
      name: server.name,
      config: server.config,
      scope: server.scope,
      enabled: server.enabled,
      approval: server.approval,
      status,
      tools: [],
      resources: [],
      prompts: []
    }
    this.connections.set(server.name, conn)

    if (status !== 'connecting') return

    try {
      const client = new Client(
        { name: MCP_CLIENT_NAME, version: APP_VERSION },
        { capabilities: {} }
      )
      const transport = createTransport(server.config)
      client.onclose = () => {
        const c = this.connections.get(server.name)
        if (c && c.status === 'connected') {
          c.status = 'failed'
          c.error = '连接已关闭'
          this.emitChange()
        }
      }
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 MCP server "${server.name}"`)
      conn.client = client
      conn.transport = transport
      conn.serverInfo = client.getServerVersion()
      const caps = client.getServerCapabilities()
      conn.capabilities = {
        resources: !!caps?.resources,
        prompts: !!caps?.prompts
      }
      await this.discover(conn)
      conn.status = 'connected'
    } catch (e) {
      conn.status = 'failed'
      conn.error = e instanceof Error ? e.message : String(e)
    }
  }

  private async discover(conn: ServerConnection): Promise<void> {
    const client = conn.client
    if (!client) return

    try {
      const toolsResult = await client.listTools()
      conn.tools = (toolsResult.tools ?? []).map((t) => {
        const annotations = (t.annotations ?? {}) as {
          readOnlyHint?: boolean
          destructiveHint?: boolean
        }
        const readOnly = annotations.readOnlyHint === true
        return {
          qualifiedName: buildMcpToolName(conn.name, t.name),
          originalName: t.name,
          description: t.description ?? `MCP 工具 ${t.name}`,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          readOnly,
          // 只读工具不视为破坏性；其余尊重 destructiveHint（MCP 默认 true）。
          destructive: readOnly ? false : annotations.destructiveHint !== false
        }
      })
    } catch (e) {
      conn.tools = []
      console.error(`[mcp] ${conn.name} listTools 失败:`, e)
    }

    if (conn.capabilities?.resources) {
      try {
        const res = await client.listResources()
        conn.resources = (res.resources ?? []).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType
        }))
      } catch (e) {
        console.error(`[mcp] ${conn.name} listResources 失败:`, e)
      }
    }

    if (conn.capabilities?.prompts) {
      try {
        const res = await client.listPrompts()
        conn.prompts = (res.prompts ?? []).map((p) => ({
          name: p.name,
          description: p.description
        }))
      } catch (e) {
        console.error(`[mcp] ${conn.name} listPrompts 失败:`, e)
      }
    }
  }

  // 调用某个 MCP 工具（qualifiedName 为 mcp__server__tool）。
  async callTool(
    serverName: string,
    originalToolName: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean; images: { dataUrl: string }[] }> {
    const conn = this.connections.get(serverName)
    if (!conn || !conn.client) {
      return { text: `MCP server "${serverName}" 未连接`, isError: true, images: [] }
    }
    try {
      const result = await withTimeout(
        conn.client.callTool({ name: originalToolName, arguments: args }),
        CALL_TIMEOUT_MS,
        `调用 ${serverName}/${originalToolName}`
      )
      return transformToolResult(result as never)
    } catch (e) {
      return { text: e instanceof Error ? e.message : '工具调用失败', isError: true, images: [] }
    }
  }

  async readResource(serverName: string, uri: string): Promise<{ text: string; isError: boolean }> {
    const conn = this.connections.get(serverName)
    if (!conn || !conn.client) return { text: `MCP server "${serverName}" 未连接`, isError: true }
    try {
      const result = await withTimeout(
        conn.client.readResource({ uri }),
        CALL_TIMEOUT_MS,
        `读取资源 ${uri}`
      )
      return { text: transformResourceResult(result.contents as never), isError: false }
    } catch (e) {
      return { text: e instanceof Error ? e.message : '读取资源失败', isError: true }
    }
  }

  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, string>
  ): Promise<{ text: string; isError: boolean }> {
    const conn = this.connections.get(serverName)
    if (!conn || !conn.client) return { text: `MCP server "${serverName}" 未连接`, isError: true }
    try {
      const result = await withTimeout(
        conn.client.getPrompt({ name, arguments: args }),
        CALL_TIMEOUT_MS,
        `获取 prompt ${name}`
      )
      return { text: transformPromptResult(result.messages as never), isError: false }
    } catch (e) {
      return { text: e instanceof Error ? e.message : '获取 prompt 失败', isError: true }
    }
  }

  // 所有已连接 server 的工具汇总（供注册到 ToolRegistry）。
  allTools(): { serverName: string; tools: McpDiscoveredTool[] }[] {
    const out: { serverName: string; tools: McpDiscoveredTool[] }[] = []
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.tools.length > 0) {
        out.push({ serverName: conn.name, tools: conn.tools })
      }
    }
    return out
  }

  // 是否存在带资源能力的已连接 server（决定是否注册资源工具）。
  hasResourceCapableServer(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.resources.length > 0) return true
    }
    return false
  }

  listResourceEntries(): { serverName: string; resources: DiscoveredResource[] }[] {
    const out: { serverName: string; resources: DiscoveredResource[] }[] = []
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.resources.length > 0) {
        out.push({ serverName: conn.name, resources: conn.resources })
      }
    }
    return out
  }

  hasPromptCapableServer(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.prompts.length > 0) return true
    }
    return false
  }

  listPromptEntries(): { serverName: string; prompts: DiscoveredPrompt[] }[] {
    const out: { serverName: string; prompts: DiscoveredPrompt[] }[] = []
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.prompts.length > 0) {
        out.push({ serverName: conn.name, prompts: conn.prompts })
      }
    }
    return out
  }

  // 运行时状态快照（供 UI / IPC）。
  statusSnapshot(): ServerConnection[] {
    return [...this.connections.values()]
  }

  // 构建供 UI 展示的详细状态列表。
  buildDetails(): import('@shared/mcpTypes').McpServerDetail[] {
    return [...this.connections.values()].map((conn) => ({
      name: conn.name,
      scope: conn.scope,
      transport: transportTypeOf(conn.config),
      status: conn.status,
      enabled: conn.enabled,
      error: conn.error,
      toolCount: conn.tools.length,
      resourceCount: conn.resources.length,
      promptCount: conn.prompts.length,
      serverInfo: conn.serverInfo
        ? { name: conn.serverInfo.name, version: conn.serverInfo.version }
        : undefined,
      config: conn.config,
      tools: this.toToolSummaries(conn),
      resources: this.toResourceSummaries(conn),
      prompts: this.toPromptSummaries(conn)
    }))
  }

  // 临时连接以测试某个配置是否可用，结束后立即断开。
  async testConfig(config: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number; serverInfo?: { name: string; version: string } }> {
    let client: Client | undefined
    try {
      client = new Client({ name: MCP_CLIENT_NAME, version: APP_VERSION }, { capabilities: {} })
      const transport = createTransport(config)
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '测试连接')
      const info = client.getServerVersion()
      const tools = await client.listTools()
      return {
        ok: true,
        toolCount: tools.tools?.length ?? 0,
        serverInfo: info ? { name: info.name, version: info.version } : undefined
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      try {
        await client?.close()
      } catch {
        // 忽略
      }
    }
  }

  toToolSummaries(conn: ServerConnection): McpToolSummary[] {
    return conn.tools.map((t) => ({
      qualifiedName: t.qualifiedName,
      originalName: t.originalName,
      description: t.description,
      readOnly: t.readOnly
    }))
  }

  toResourceSummaries(conn: ServerConnection): McpResourceSummary[] {
    return conn.resources
  }

  toPromptSummaries(conn: ServerConnection): McpPromptSummary[] {
    return conn.prompts
  }

  private async closeConnection(conn: ServerConnection): Promise<void> {
    try {
      await conn.client?.close()
    } catch {
      // 忽略关闭异常
    }
    conn.client = undefined
    conn.transport = undefined
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => this.closeConnection(c)))
    this.connections.clear()
  }
}

let manager: McpManager | null = null

export function getMcpManager(): McpManager {
  if (!manager) manager = new McpManager()
  return manager
}

export type { ServerConnection }
