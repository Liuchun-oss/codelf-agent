import { lookup } from 'dns/promises'
import { isIP } from 'net'



export interface UrlGuardResult {
  ok: boolean
  error?: string
  
  url?: URL
}


export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isPrivateIpv4(ip)
  if (v === 6) return isPrivateIpv6(ip)
  return true 
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true
  const [a, b] = parts
  if (a === 10) return true 
  if (a === 127) return true 
  if (a === 0) return true 
  if (a === 169 && b === 254) return true 
  if (a === 172 && b >= 16 && b <= 31) return true 
  if (a === 192 && b === 168) return true 
  if (a === 100 && b >= 64 && b <= 127) return true 
  if (a >= 224) return true 
  return false
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true 
  if (lower.startsWith('fe80')) return true 
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true 
  
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIpv4(mapped[1])
  return false
}


export async function guardOutboundUrl(raw: string): Promise<UrlGuardResult> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'URL 格式无效' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议：${url.protocol}（仅允许 http/https）` }
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')
  const lowerHost = host.toLowerCase()
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) {
    return { ok: false, error: '拒绝访问本地主机' }
  }

  if (isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, error: '拒绝访问内网 / 回环地址' }
    return { ok: true, url }
  }

  
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    return { ok: false, error: `无法解析主机：${host}` }
  }
  if (addrs.length === 0) return { ok: false, error: `主机无可用地址：${host}` }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      return { ok: false, error: '该域名解析到内网地址，已拒绝' }
    }
  }
  return { ok: true, url }
}
