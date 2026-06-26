// 微信语音 silk 转码：SILK → WAV（pcm_s16le）。
// 复刻自腾讯官方插件 src/media/silk-transcode.ts，依赖 silk-wasm。
const SILK_SAMPLE_RATE = 24_000

// 把 pcm_s16le 裸数据包成 WAV 容器（单声道，16-bit 小端）。
function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength
  const totalSize = 44 + pcmBytes
  const buf = Buffer.allocUnsafe(totalSize)
  let offset = 0
  buf.write('RIFF', offset); offset += 4
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4
  buf.write('WAVE', offset); offset += 4
  buf.write('fmt ', offset); offset += 4
  buf.writeUInt32LE(16, offset); offset += 4
  buf.writeUInt16LE(1, offset); offset += 2
  buf.writeUInt16LE(1, offset); offset += 2
  buf.writeUInt32LE(sampleRate, offset); offset += 4
  buf.writeUInt32LE(sampleRate * 2, offset); offset += 4
  buf.writeUInt16LE(2, offset); offset += 2
  buf.writeUInt16LE(16, offset); offset += 2
  buf.write('data', offset); offset += 4
  buf.writeUInt32LE(pcmBytes, offset); offset += 4
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset)
  return buf
}

// 尝试把 SILK 转 WAV。silk-wasm 不可用或解码失败时返回 null，调用方可降级存原始 silk。
export async function silkToWav(silkBuf: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import('silk-wasm')
    const result = await decode(silkBuf, SILK_SAMPLE_RATE)
    return pcmBytesToWav(result.data, SILK_SAMPLE_RATE)
  } catch {
    return null
  }
}

// 探测 silk-wasm 是否可加载（供 /diag 自检；不做实际解码）。
export async function isSilkAvailable(): Promise<boolean> {
  try {
    const mod = await import('silk-wasm')
    return typeof mod.decode === 'function'
  } catch {
    return false
  }
}
