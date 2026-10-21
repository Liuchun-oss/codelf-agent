import { deflateSync } from 'zlib'

// BMP / ICO 内层 DIB → PNG 的极简转码器。
// 为什么手写：模型服务端只接受 png/jpeg/gif/webp，而 sharp（libvips）根本没有 bmp/ico
// 解码器。Windows 图标（.ico）、截图与画图工具产出的 .bmp 在 IDE 场景很常见，一旦被当
// 图片透传就是整条请求 400（"You have uploaded an unsupported image"），且那张坏图留在
// 历史里每轮重发、每轮被拒。这里只覆盖实际会遇到的子集：1/4/8bpp 调色板、16/24/32bpp
// 位深，BI_RGB / BI_BITFIELDS，自底向上或自顶向下；其余（RLE 压缩、OS/2 核心头）返回 null
// 由上层降级为「只给路径、不发图片」。

export interface RgbaImage {
  width: number
  height: number
  rgba: Buffer
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0
    image.rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// 解码一段 BITMAPINFOHEADER(V4/V5) 起头的位图数据。
// icoFrame=true 时高度字段是「XOR 图像 + AND 掩码」的两倍，需要折半。
function decodeDib(buf: Buffer, opts: { icoFrame: boolean }): RgbaImage | null {
  if (buf.length < 40) return null
  const dibSize = buf.readUInt32LE(0)
  if (dibSize < 40 || buf.length < dibSize) return null
  const width = buf.readInt32LE(4)
  const rawHeight = buf.readInt32LE(8)
  const bpp = buf.readUInt16LE(14)
  const compression = buf.readUInt32LE(16)
  const colorsUsed = buf.readUInt32LE(32)
  if (width <= 0 || rawHeight === 0) return null
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null
  // 0=BI_RGB，3=BI_BITFIELDS（32bpp 实际按 BGRA 处理，够用）
  if (compression !== 0 && compression !== 3) return null

  let height = Math.abs(rawHeight)
  if (opts.icoFrame) {
    if (height % 2 !== 0) return null
    height /= 2
  }
  const topDown = rawHeight < 0
  const paletteCount = bpp <= 8 ? colorsUsed || 1 << bpp : 0
  const paletteOffset = dibSize
  const dataOffset = paletteOffset + paletteCount * 4
  const rowStride = (((width * bpp + 31) >> 5) * 4) as number
  if (dataOffset + rowStride * height > buf.length) return null

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const srcRow = dataOffset + (topDown ? y : height - 1 - y) * rowStride
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      if (bpp === 32 || bpp === 24) {
        const p = srcRow + x * (bpp >> 3)
        b = buf[p]!
        g = buf[p + 1]!
        r = buf[p + 2]!
        if (bpp === 32) a = buf[p + 3]!
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(srcRow + x * 2)
        r = ((v >> 10) & 0x1f) * 8
        g = ((v >> 5) & 0x1f) * 8
        b = (v & 0x1f) * 8
      } else {
        let index: number
        if (bpp === 8) index = buf[srcRow + x]!
        else if (bpp === 4) index = (buf[srcRow + (x >> 1)]! >> (x % 2 === 0 ? 4 : 0)) & 0x0f
        else index = (buf[srcRow + (x >> 3)]! >> (7 - (x % 8))) & 0x01
        const p = paletteOffset + index * 4
        if (p + 3 >= buf.length) return null
        b = buf[p]!
        g = buf[p + 1]!
        r = buf[p + 2]!
      }
      rgba[out] = r
      rgba[out + 1] = g
      rgba[out + 2] = b
      rgba[out + 3] = a
    }
  }
  return { width, height, rgba }
}

export function bmpToPng(buf: Buffer): Buffer | null {
  if (buf.length < 26 || buf.readUInt16LE(0) !== 0x4d42) return null
  const dibSize = buf.readUInt32LE(14)
  if (dibSize < 40 || 14 + dibSize > buf.length) return null
  // 14 字节文件头之后就是 DIB（信息头 + 调色板 + 像素），偏移全部相对 DIB 起点计算。
  const image = decodeDib(buf.subarray(14), { icoFrame: false })
  return image ? encodePng(image) : null
}

export function icoToPng(buf: Buffer): Buffer | null {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null
  const count = buf.readUInt16LE(4)
  // 多尺寸图标取像素最多的那帧，避免把 16x16 发给模型看不清。
  let best: { png: Buffer; pixels: number } | null = null
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16
    if (entry + 16 > buf.length) break
    const bytes = buf.readUInt32LE(entry + 8)
    const start = buf.readUInt32LE(entry + 12)
    if (bytes <= 0 || start + bytes > buf.length) continue
    const frame = buf.subarray(start, start + bytes)
    // 现代 .ico 常直接内嵌 PNG 帧，原样取出即可，无需解码。宽高从 IHDR 读。
    if (frame.length >= 24 && frame.readUInt32BE(0) === 0x89504e47) {
      const pixels = frame.readUInt32BE(16) * frame.readUInt32BE(20)
      if (!best || pixels > best.pixels) best = { png: Buffer.from(frame), pixels }
      continue
    }
    const image = decodeDib(frame, { icoFrame: true })
    if (image) {
      const pixels = image.width * image.height
      if (!best || pixels > best.pixels) best = { png: encodePng(image), pixels }
    }
  }
  return best ? best.png : null
}
