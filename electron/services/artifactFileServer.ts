import { readFile } from 'fs/promises'
import { extname } from 'path'
import { ARTIFACT_FILE_SCHEME } from '@shared/appConfig'

export { ARTIFACT_FILE_SCHEME }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Build an artifact-scheme URL for a local file path. Uses a fixed host so the
 * scheme parses as standard (relative assets like ./style.css resolve against
 * the same dir). e.g. D:\a\index.html → codelf-artifact://local/D:/a/index.html
 */
export function toArtifactUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `${ARTIFACT_FILE_SCHEME}://local${encodeURI(withLeadingSlash)}`
}

/** Map an incoming artifact-scheme request URL back to an absolute fs path. */
function requestUrlToPath(requestUrl: string): string {
  const parsed = new URL(requestUrl)
  let p = decodeURIComponent(parsed.pathname) // "/D:/a/index.html" or "/home/u/x"
  // Strip the leading slash before a Windows drive letter ("/D:/" → "D:/").
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  return p
}

export async function readArtifactFile(
  requestUrl: string
): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const filePath = requestUrlToPath(requestUrl)
    const data = await readFile(filePath)
    return { data, mime: mimeFor(filePath) }
  } catch {
    return null
  }
}
