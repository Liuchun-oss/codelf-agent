import type { ToolRegistry } from '../tools/registry'
import { MCP_TOOL_PREFIX } from './naming'
import { buildMcpTools } from './toolWrapper'
import { getMcpManager } from './manager'
import {
  LIST_MCP_RESOURCES_NAME,
  READ_MCP_RESOURCE_NAME,
  LIST_MCP_PROMPTS_NAME,
  GET_MCP_PROMPT_NAME,
  listMcpResourcesTool,
  readMcpResourceTool,
  listMcpPromptsTool,
  getMcpPromptTool
} from './resourceTools'

// 把当前已连接 MCP server 的工具与资源工具同步进给定 registry。
// 先清除旧的 MCP 工具，再注册最新的，保证重连/增删 server 后状态一致。
// 重新注册会重置 deferred「已发现」标记，因此这里先快照、再恢复，
// 避免模型在多轮对话中已发现的 MCP 工具被无故重置。
export function syncMcpToolsIntoRegistry(registry: ToolRegistry): void {
  const previouslyDiscovered = new Set(registry.discoveredDeferredToolNames())

  registry.unregisterByPrefix(MCP_TOOL_PREFIX)
  registry.unregister(LIST_MCP_RESOURCES_NAME)
  registry.unregister(READ_MCP_RESOURCE_NAME)
  registry.unregister(LIST_MCP_PROMPTS_NAME)
  registry.unregister(GET_MCP_PROMPT_NAME)

  for (const tool of buildMcpTools()) {
    registry.register(tool)
  }

  const manager = getMcpManager()
  if (manager.hasResourceCapableServer()) {
    registry.register(listMcpResourcesTool)
    registry.register(readMcpResourceTool)
  }
  if (manager.hasPromptCapableServer()) {
    registry.register(listMcpPromptsTool)
    registry.register(getMcpPromptTool)
  }

  // 恢复仍然存在的工具的「已发现」标记。
  for (const name of previouslyDiscovered) {
    registry.markDeferredToolDiscovered(name)
  }
}

// 确保 MCP 已按工作区连接，然后同步工具进 registry。
export async function ensureMcpReady(registry: ToolRegistry, workspaceRoot: string | null): Promise<void> {
  await getMcpManager().ensureConnected(workspaceRoot)
  syncMcpToolsIntoRegistry(registry)
}
