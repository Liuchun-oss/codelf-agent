import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { guardOutboundUrl } from './ssrfGuard'
import { WEB_FETCH_NAME, WEB_FETCH_DESCRIPTION } from '../prompts/tools/webFetch'
import { userAgent } from '@shared/appConfig'


const MAX_BODY_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

const MAX_REDIRECTS = 5

const webFetchSchema = z.object({
  url: z.string().min(1).describe('Fully-qualified http/https URL to fetch')
})
type WebFetchInput = z.infer<typeof webFetchSchema>


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

function limitUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return { text: text.slice(0, end), truncated: true }
}


export const webFetchTool: Tool<WebFetchInput> = {
  name: WEB_FETCH_NAME,
  description: WEB_FETCH_DESCRIPTION,
  schema: webFetchSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const guard = await guardOutboundUrl(input.url)
    if (!guard.ok || !guard.url) {
      return { content: `已拒绝抓取：${guard.error ?? 'URL 不安全'}`, isError: true }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    
    const onAbort = (): void => controller.abort()
    ctx.signal?.addEventListener('abort', onAbort)

    try {
      
      let currentUrl = guard.url.toString()
      let res: Response
      let hops = 0
      
      while (true) {
        res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': userAgent('web_fetch') }
        })
        
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          if (hops >= MAX_REDIRECTS) {
            return { content: '重定向次数过多，已停止', isError: true }
          }
          const next = new URL(res.headers.get('location') as string, currentUrl).toString()
          const nextGuard = await guardOutboundUrl(next)
          if (!nextGuard.ok || !nextGuard.url) {
            return { content: `已拒绝跟随重定向：${nextGuard.error ?? 'URL 不安全'}`, isError: true }
          }
          currentUrl = nextGuard.url.toString()
          hops++
          continue
        }
        break
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (/^(image|audio|video|application\/(octet-stream|zip|pdf))/i.test(contentType)) {
        return {
          content: `已获取 ${currentUrl}（HTTP ${res.status}，content-type: ${contentType}）。二进制内容不作为文本返回。`,
          isError: false
        }
      }

      const reader = res.body?.getReader()
      let received = 0
      const chunks: Uint8Array[] = []
      let truncated = false
      if (reader) {
        
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            const remaining = MAX_BODY_BYTES - received
            if (value.length > remaining) {
              chunks.push(value.slice(0, Math.max(remaining, 0)))
              received = MAX_BODY_BYTES
              truncated = true
              await reader.cancel().catch(() => {})
              break
            }
            chunks.push(value)
            received += value.length
            if (received >= MAX_BODY_BYTES) {
              truncated = true
              await reader.cancel().catch(() => {})
              break
            }
          }
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      let text = buf.toString('utf8')
      if (/text\/html|application\/xhtml/i.test(contentType)) {
        text = htmlToText(text)
      }
      const limited = limitUtf8Bytes(text, MAX_BODY_BYTES)
      text = limited.text
      truncated = truncated || limited.truncated

      const header = `GET ${currentUrl} → HTTP ${res.status} (${contentType || 'unknown'})\n\n`
      return { content: header + (text || '(空响应)'), truncated, isError: !res.ok }
    } catch (e) {
      if (controller.signal.aborted) {
        return { content: '请求已取消或超时', isError: true }
      }
      return { content: e instanceof Error ? e.message : '抓取失败', isError: true }
    } finally {
      clearTimeout(timeout)
      ctx.signal?.removeEventListener('abort', onAbort)
    }
  }
}
