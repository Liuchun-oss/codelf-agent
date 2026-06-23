import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { sendToRenderer } from '../../services/localWriteRegistry'
import { OPEN_IN_APP_BROWSER_NAME, OPEN_IN_APP_BROWSER_DESCRIPTION } from '../prompts/tools/browser'

const openInAppBrowserSchema = z.object({
  url: z.string().min(1).describe('Fully-qualified http/https URL to open in the built-in browser tab (loopback allowed)')
})

type OpenInAppBrowserInput = z.infer<typeof openInAppBrowserSchema>

export const openInAppBrowserTool: Tool<OpenInAppBrowserInput> = {
  name: OPEN_IN_APP_BROWSER_NAME,
  description: OPEN_IN_APP_BROWSER_DESCRIPTION,
  schema: openInAppBrowserSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return { content: `URL 格式无效：${input.url}`, isError: true }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { content: `仅支持 http/https，收到：${url.protocol}`, isError: true }
    }
    const delivered = sendToRenderer('browser:openUrl', url.toString())
    if (!delivered) {
      return { content: '无法打开内置浏览器：主窗口不可用。', isError: true }
    }
    return { content: `已在 Codelf 内置浏览器中打开：${url.toString()}` }
  }
}
