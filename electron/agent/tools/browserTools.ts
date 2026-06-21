import { z } from 'zod'
import type { Page } from 'playwright'
import type { Tool, ToolResult } from './types'
import { guardOutboundUrl } from './ssrfGuard'
import {
  openBrowserSession,
  getBrowserSession,
  getActivePage,
  closeBrowserSession,
  refreshPages,
  setActivePageIndex,
  closePageAtIndex
} from '../../services/browserSession'
import { storeBrowserPreview, browserPreviewUrl } from '../../services/browserPreviewImage'
import {
  BROWSER_OPEN_NAME,
  BROWSER_OPEN_DESCRIPTION,
  BROWSER_NAVIGATE_NAME,
  BROWSER_NAVIGATE_DESCRIPTION,
  BROWSER_CLICK_NAME,
  BROWSER_CLICK_DESCRIPTION,
  BROWSER_TYPE_NAME,
  BROWSER_TYPE_DESCRIPTION,
  BROWSER_SNAPSHOT_NAME,
  BROWSER_SNAPSHOT_DESCRIPTION,
  BROWSER_GET_CONTENT_NAME,
  BROWSER_GET_CONTENT_DESCRIPTION,
  BROWSER_SCREENSHOT_NAME,
  BROWSER_SCREENSHOT_DESCRIPTION,
  BROWSER_WAIT_FOR_NAME,
  BROWSER_WAIT_FOR_DESCRIPTION,
  BROWSER_HANDOFF_NAME,
  BROWSER_HANDOFF_DESCRIPTION,
  BROWSER_TABS_NAME,
  BROWSER_TABS_DESCRIPTION,
  BROWSER_COOKIES_NAME,
  BROWSER_COOKIES_DESCRIPTION,
  BROWSER_CLOSE_NAME,
  BROWSER_CLOSE_DESCRIPTION
} from '../prompts/tools/browser'

const NAV_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 15_000
const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_SNAPSHOT_NODES = 200

const MAX_HANDOFF_IMAGE_BYTES = 380_000

const MAX_SCREENSHOT_BYTES = 5_000_000

const JPEG_QUALITIES = [85, 70, 55, 40, 25, 15, 10] as const

interface CapturedScreenshot {
  buffer: Buffer
  mime: string
  
  compressed: boolean
}


async function captureScreenshotBytes(
  page: Page,
  options?: { fullPage?: boolean; maxBytes?: number }
): Promise<CapturedScreenshot | null> {
  const fullPage = options?.fullPage ?? false
  const maxBytes = options?.maxBytes

  if (!maxBytes) {
    const buffer = Buffer.from(await page.screenshot({ fullPage, type: 'png' }))
    return { buffer, mime: 'image/png', compressed: false }
  }

  let smallest: CapturedScreenshot | null = null
  for (const quality of JPEG_QUALITIES) {
    const buffer = Buffer.from(await page.screenshot({ fullPage, type: 'jpeg', quality }))
    const candidate: CapturedScreenshot = { buffer, mime: 'image/jpeg', compressed: true }
    if (!smallest || buffer.length < smallest.buffer.length) smallest = candidate
    if (buffer.length <= maxBytes) return candidate
  }
  return smallest && smallest.buffer.length <= maxBytes ? smallest : null
}


function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function requireSession(sessionId: string): ToolResult | null {
  const session = getBrowserSession(sessionId)
  if (!session || session.status !== 'open') {
    return { content: `浏览器会话不存在或已关闭：${sessionId}。请先调用 ${BROWSER_OPEN_NAME}。`, isError: true }
  }
  return null
}

async function pageState(sessionId: string): Promise<string> {
  const page = getActivePage(sessionId)
  if (!page) return '(无活动页面)'
  try {
    const title = await page.title()
    return `URL: ${page.url()}\nTitle: ${title}`
  } catch {
    return `URL: ${page.url()}`
  }
}



const openSchema = z.object({
  url: z.string().optional().describe('Optional initial http/https URL to navigate to on open'),
  viewport: z
    .object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) })
    .optional()
    .describe('Optional viewport size')
})
type OpenInput = z.infer<typeof openSchema>

export const browserOpenTool: Tool<OpenInput> = {
  name: BROWSER_OPEN_NAME,
  description: BROWSER_OPEN_DESCRIPTION,
  schema: openSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    if (input.url) {
      const guard = await guardOutboundUrl(input.url)
      if (!guard.ok) return { content: `已拒绝打开：${guard.error ?? 'URL 不安全'}`, isError: true }
    }
    let sessionId: string | undefined
    try {
      const session = await openBrowserSession({
        agentSessionId: ctx.sessionId,
        viewport: input.viewport
      })
      sessionId = session.id
      if (input.url) {
        const page = getActivePage(session.id)
        await page?.goto(input.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
      }
      const state = await pageState(session.id)
      return { content: `Browser session opened: ${session.id}\n${state}` }
    } catch (e) {
      if (sessionId) await closeBrowserSession(sessionId)
      const msg = e instanceof Error ? e.message : '打开浏览器失败'
      return { content: msg, isError: true }
    }
  }
}



const navigateSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id from BrowserOpen'),
  url: z.string().min(1).describe('Fully-qualified http/https URL'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('Load completion condition')
})
type NavigateInput = z.infer<typeof navigateSchema>

export const browserNavigateTool: Tool<NavigateInput> = {
  name: BROWSER_NAVIGATE_NAME,
  description: BROWSER_NAVIGATE_DESCRIPTION,
  schema: navigateSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const guard = await guardOutboundUrl(input.url)
    if (!guard.ok) return { content: `已拒绝导航：${guard.error ?? 'URL 不安全'}`, isError: true }
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      await page.goto(input.url, { waitUntil: input.waitUntil ?? 'load', timeout: NAV_TIMEOUT_MS })
      return { content: `Navigated.\n${await pageState(input.sessionId)}` }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '导航失败', isError: true }
    }
  }
}



const clickSchema = z
  .object({
    sessionId: z.string().min(1).describe('Browser session id'),
    selector: z.string().optional().describe('CSS selector of the element to click'),
    ref: z.string().optional().describe('Element ref from BrowserSnapshot')
  })
  .refine((v) => v.selector || v.ref, { message: 'Provide either selector or ref' })
type ClickInput = z.infer<typeof clickSchema>

export const browserClickTool: Tool<ClickInput> = {
  name: BROWSER_CLICK_NAME,
  description: BROWSER_CLICK_DESCRIPTION,
  schema: clickSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      if (input.ref) {
        await page.locator(`aria-ref=${input.ref}`).click({ timeout: ACTION_TIMEOUT_MS })
      } else if (input.selector) {
        await page.locator(input.selector).first().click({ timeout: ACTION_TIMEOUT_MS })
      }
      await page.waitForLoadState('load', { timeout: ACTION_TIMEOUT_MS }).catch(() => {})
      return { content: `Clicked.\n${await pageState(input.sessionId)}` }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '点击失败', isError: true }
    }
  }
}



const typeSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  selector: z.string().min(1).describe('CSS selector of the input/textarea'),
  text: z.string().describe('Text to fill into the field'),
  submit: z.boolean().optional().describe('Press Enter after typing to submit')
})
type TypeInput = z.infer<typeof typeSchema>

export const browserTypeTool: Tool<TypeInput> = {
  name: BROWSER_TYPE_NAME,
  description: BROWSER_TYPE_DESCRIPTION,
  schema: typeSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      const locator = page.locator(input.selector).first()
      await locator.fill(input.text, { timeout: ACTION_TIMEOUT_MS })
      if (input.submit) {
        await locator.press('Enter', { timeout: ACTION_TIMEOUT_MS })
        await page.waitForLoadState('load', { timeout: ACTION_TIMEOUT_MS }).catch(() => {})
      }
      return { content: `Typed${input.submit ? ' and submitted' : ''}.\n${await pageState(input.sessionId)}` }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '输入失败', isError: true }
    }
  }
}



const sessionOnlySchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id')
})
type SessionOnlyInput = z.infer<typeof sessionOnlySchema>

export const browserSnapshotTool: Tool<SessionOnlyInput> = {
  name: BROWSER_SNAPSHOT_NAME,
  description: BROWSER_SNAPSHOT_DESCRIPTION,
  schema: sessionOnlySchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' })
      const lines = snapshot.split('\n')
      const truncated = lines.length > MAX_SNAPSHOT_NODES
      const body = truncated ? lines.slice(0, MAX_SNAPSHOT_NODES).join('\n') : snapshot
      return {
        content: `Accessibility snapshot (use [ref=...] with BrowserClick):\n${body}`,
        truncated
      }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '快照失败', isError: true }
    }
  }
}



const getContentSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  format: z.enum(['html', 'text']).optional().describe("'html' for source, 'text' for readable text")
})
type GetContentInput = z.infer<typeof getContentSchema>

export const browserGetContentTool: Tool<GetContentInput> = {
  name: BROWSER_GET_CONTENT_NAME,
  description: BROWSER_GET_CONTENT_DESCRIPTION,
  schema: getContentSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      const html = await page.content()
      let text = (input.format ?? 'text') === 'html' ? html : htmlToText(html)
      let truncated = false
      if (text.length > MAX_CONTENT_BYTES) {
        text = text.slice(0, MAX_CONTENT_BYTES)
        truncated = true
      }
      const header = `${page.url()} (${input.format ?? 'text'})\n\n`
      return { content: header + (text || '(空)'), truncated }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '取内容失败', isError: true }
    }
  }
}



const screenshotSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  fullPage: z.boolean().optional().describe('Capture the full scrollable page')
})
type ScreenshotInput = z.infer<typeof screenshotSchema>

export const browserScreenshotTool: Tool<ScreenshotInput> = {
  name: BROWSER_SCREENSHOT_NAME,
  description: BROWSER_SCREENSHOT_DESCRIPTION,
  schema: screenshotSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    try {
      const shot = await captureScreenshotBytes(page, {
        fullPage: input.fullPage,
        maxBytes: MAX_SCREENSHOT_BYTES
      })
      if (!shot) {
        return {
          content:
            '截图过大，无法在界面内嵌显示。请使用 fullPage:false 重试，或缩小页面/视口后再截图。',
          isError: true
        }
      }
      const previewId = await storeBrowserPreview(shot.buffer, shot.mime)
      if (ctx.emitEvent && ctx.turnId && ctx.toolCallId) {
        ctx.emitEvent({
          type: 'tool_call_progress',
          turnId: ctx.turnId,
          callId: ctx.toolCallId,
          status: 'running',
          message: shot.compressed ? 'Screenshot captured (compressed).' : 'Screenshot captured.'
        })
      }
      const note = shot.compressed ? '\n\n_(预览已自动压缩以适配显示。)_' : ''
      return {
        content: `Screenshot of ${page.url()}:\n\n![screenshot](${browserPreviewUrl(previewId)})${note}`
      }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '截图失败', isError: true }
    }
  }
}



const waitForSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  selector: z.string().optional().describe('CSS selector to wait for; omit to wait for network idle'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('Target element state'),
  timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Max wait in ms (default 15000)')
})
type WaitForInput = z.infer<typeof waitForSchema>

export const browserWaitForTool: Tool<WaitForInput> = {
  name: BROWSER_WAIT_FOR_NAME,
  description: BROWSER_WAIT_FOR_DESCRIPTION,
  schema: waitForSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const page = getActivePage(input.sessionId)
    if (!page) return { content: '无活动页面', isError: true }
    const timeout = input.timeoutMs ?? ACTION_TIMEOUT_MS
    try {
      if (input.selector) {
        await page.locator(input.selector).first().waitFor({ state: input.state ?? 'visible', timeout })
        return { content: `Element "${input.selector}" reached state "${input.state ?? 'visible'}".` }
      }
      await page.waitForLoadState('networkidle', { timeout })
      return { content: 'Network idle.' }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '等待超时', isError: true }
    }
  }
}



const handoffSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  message: z.string().min(1).describe('What the user should do in the browser window')
})
type HandoffInput = z.infer<typeof handoffSchema>

export const browserHandoffTool: Tool<HandoffInput> = {
  name: BROWSER_HANDOFF_NAME,
  description: BROWSER_HANDOFF_DESCRIPTION,
  schema: handoffSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    if (!ctx.requestUserQuestion) {
      return { content: 'BrowserHandoff 需要由编排层提供 requestUserQuestion 能力', isError: true }
    }
    const page = getActivePage(input.sessionId)
    let previewImageId: string | undefined
    let previewNote = ''
    if (page) {
      try {
        const shot = await captureScreenshotBytes(page, { maxBytes: MAX_HANDOFF_IMAGE_BYTES })
        if (shot) {
          previewImageId = await storeBrowserPreview(shot.buffer, shot.mime)
          if (shot.compressed) previewNote = '\n\n（预览已自动压缩）'
        } else {
          previewNote = '\n\n（页面预览过大，已省略缩略图，请直接查看已打开的浏览器窗口。）'
        }
        if (ctx.emitEvent && ctx.turnId && ctx.toolCallId) {
          ctx.emitEvent({
            type: 'tool_call_progress',
            turnId: ctx.turnId,
            callId: ctx.toolCallId,
            status: 'waiting',
            message: shot
              ? '等待用户在浏览器窗口操作（已附当前页面预览）。'
              : '等待用户在浏览器窗口操作（预览过大已省略，请查看浏览器窗口）。'
          })
        }
      } catch {
        
      }
    }
    const question = `${input.message}${previewNote}\n\n请在已打开的浏览器窗口完成上述操作，完成后点击下方按钮继续。`
    const response = await ctx.requestUserQuestion(question, ['已完成，继续'], { previewImageId })
    if (response.cancelled) {
      return { content: '用户取消了手动操作（handoff cancelled）。', isError: true }
    }
    return { content: `用户已完成手动操作。当前页面：\n${await pageState(input.sessionId)}` }
  }
}



const tabsSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  action: z.enum(['list', 'new', 'select', 'close']).describe('Tab action'),
  index: z.number().int().min(0).optional().describe('Tab index for select/close'),
  url: z.string().optional().describe('Optional URL for new tab')
})
type TabsInput = z.infer<typeof tabsSchema>

async function listTabs(sessionId: string): Promise<string> {
  const pages = refreshPages(sessionId)
  const session = getBrowserSession(sessionId)
  const active = session?.activePageIndex ?? 0
  const lines = await Promise.all(
    pages.map(async (p, i) => {
      let title = ''
      try {
        title = await p.title()
      } catch {
        
      }
      return `${i === active ? '*' : ' '} [${i}] ${p.url()} ${title ? `- ${title}` : ''}`
    })
  )
  return lines.join('\n') || '(无标签页)'
}

export const browserTabsTool: Tool<TabsInput> = {
  name: BROWSER_TABS_NAME,
  description: BROWSER_TABS_DESCRIPTION,
  schema: tabsSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const session = getBrowserSession(input.sessionId)
    if (!session) return { content: '会话不存在', isError: true }
    try {
      if (input.action === 'list') {
        return { content: `Tabs:\n${await listTabs(input.sessionId)}` }
      }
      if (input.action === 'new') {
        if (input.url) {
          const guard = await guardOutboundUrl(input.url)
          if (!guard.ok) return { content: `已拒绝打开：${guard.error ?? 'URL 不安全'}`, isError: true }
        }
        const page = await session.context.newPage()
        if (input.url) await page.goto(input.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
        const pages = refreshPages(input.sessionId)
        setActivePageIndex(input.sessionId, pages.length - 1)
        return { content: `Opened new tab.\nTabs:\n${await listTabs(input.sessionId)}` }
      }
      if (input.index === undefined) return { content: 'select/close 需要 index', isError: true }
      if (input.action === 'select') {
        if (!setActivePageIndex(input.sessionId, input.index)) {
          return { content: `无效的标签页 index：${input.index}`, isError: true }
        }
        return { content: `Active tab → [${input.index}].\nTabs:\n${await listTabs(input.sessionId)}` }
      }
      if (!(await closePageAtIndex(input.sessionId, input.index))) {
        return { content: `无效的标签页 index：${input.index}`, isError: true }
      }
      return { content: `Closed tab [${input.index}].\nTabs:\n${await listTabs(input.sessionId)}` }
    } catch (e) {
      return { content: e instanceof Error ? e.message : '标签页操作失败', isError: true }
    }
  }
}



const cookiesSchema = z.object({
  sessionId: z.string().min(1).describe('Browser session id'),
  action: z.enum(['get', 'clear']).describe('Cookie action')
})
type CookiesInput = z.infer<typeof cookiesSchema>

export const browserCookiesTool: Tool<CookiesInput> = {
  name: BROWSER_COOKIES_NAME,
  description: BROWSER_COOKIES_DESCRIPTION,
  schema: cookiesSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const missing = requireSession(input.sessionId)
    if (missing) return missing
    const session = getBrowserSession(input.sessionId)
    if (!session) return { content: '会话不存在', isError: true }
    try {
      if (input.action === 'clear') {
        await session.context.clearCookies()
        return { content: 'Cookies cleared.' }
      }
      const cookies = await session.context.cookies()
      if (cookies.length === 0) return { content: '(无 cookie)' }
      const lines = cookies.map((c) => `${c.name}=${c.value} (domain=${c.domain})`)
      return { content: `Cookies (${cookies.length}):\n${lines.join('\n')}` }
    } catch (e) {
      return { content: e instanceof Error ? e.message : 'cookie 操作失败', isError: true }
    }
  }
}



export const browserCloseTool: Tool<SessionOnlyInput> = {
  name: BROWSER_CLOSE_NAME,
  description: BROWSER_CLOSE_DESCRIPTION,
  schema: sessionOnlySchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input): Promise<ToolResult> {
    const closed = await closeBrowserSession(input.sessionId)
    if (!closed) return { content: `浏览器会话不存在：${input.sessionId}`, isError: true }
    return { content: `Browser session closed: ${input.sessionId}` }
  }
}

export const browserTools = [
  browserOpenTool,
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserSnapshotTool,
  browserGetContentTool,
  browserScreenshotTool,
  browserWaitForTool,
  browserHandoffTool,
  browserTabsTool,
  browserCookiesTool,
  browserCloseTool
]
