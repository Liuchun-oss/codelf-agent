import { randomUUID } from 'crypto'
import { readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BROWSER_PREVIEW_SCHEME, tmpName } from '@shared/appConfig'

export { BROWSER_PREVIEW_SCHEME }

interface PreviewEntry {
  path: string
  mime: string
}

const previews = new Map<string, PreviewEntry>()

function extForMime(mime: string): string {
  return mime === 'image/png' ? 'png' : 'jpg'
}


export async function storeBrowserPreview(buffer: Buffer, mime: string): Promise<string> {
  const id = randomUUID()
  const path = join(tmpdir(), `${tmpName('preview')}-${id}.${extForMime(mime)}`)
  await writeFile(path, buffer)
  previews.set(id, { path, mime })
  return id
}

export function getBrowserPreviewEntry(id: string): PreviewEntry | undefined {
  return previews.get(id)
}

export async function readBrowserPreview(id: string): Promise<{ data: Buffer; mime: string } | null> {
  const entry = previews.get(id)
  if (!entry) return null
  const data = await readFile(entry.path)
  return { data, mime: entry.mime }
}

export async function deleteBrowserPreview(id: string): Promise<void> {
  const entry = previews.get(id)
  if (!entry) return
  previews.delete(id)
  await unlink(entry.path).catch(() => {})
}

export async function resetBrowserPreviews(): Promise<void> {
  const ids = [...previews.keys()]
  await Promise.all(ids.map((id) => deleteBrowserPreview(id)))
}

export function browserPreviewUrl(id: string): string {
  return `${BROWSER_PREVIEW_SCHEME}://${id}`
}
