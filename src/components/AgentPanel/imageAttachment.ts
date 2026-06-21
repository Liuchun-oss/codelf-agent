import type { ImageAttachment } from '@shared/agentTypes'
import { toast } from '@/stores/toastStore'


const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export const MAX_IMAGES = 6

const SUPPORTED = /^image\/(png|jpeg|jpg|gif|webp)$/i

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}


export async function fileToImageAttachment(file: File | Blob): Promise<ImageAttachment | null> {
  const type = file.type || ''
  if (!SUPPORTED.test(type)) {
    toast.warn('仅支持 PNG / JPEG / GIF / WebP 图片')
    return null
  }
  if (file.size > MAX_IMAGE_BYTES) {
    toast.warn('图片过大（上限 4MB）')
    return null
  }
  try {
    const dataUrl = await readAsDataUrl(file)
    if (!dataUrl) return null
    const name = 'name' in file && typeof file.name === 'string' ? file.name : undefined
    return { dataUrl, name }
  } catch {
    toast.error('图片读取失败')
    return null
  }
}


export function appendImage(list: ImageAttachment[], next: ImageAttachment): ImageAttachment[] {
  if (list.some((i) => i.dataUrl === next.dataUrl)) return list
  if (list.length >= MAX_IMAGES) {
    toast.warn(`最多附加 ${MAX_IMAGES} 张图片`)
    return list
  }
  return [...list, next]
}
