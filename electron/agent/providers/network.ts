import { readFileSync } from 'fs'
import { Agent, ProxyAgent, type Dispatcher } from 'undici'
import { getNetworkSettings } from '../settings/agentSettingsStore'



let cached: { key: string; dispatcher: Dispatcher | undefined } | null = null

function systemProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  )
}

function loadCa(caCertPath: string): string | undefined {
  if (!caCertPath) return undefined
  try {
    return readFileSync(caCertPath, 'utf-8')
  } catch {
    console.error('[network] 无法读取 CA 证书：', caCertPath)
    return undefined
  }
}


export function getOutboundDispatcher(): Dispatcher | undefined {
  let net: ReturnType<typeof getNetworkSettings>
  try {
    net = getNetworkSettings()
  } catch {
    
    return undefined
  }
  const proxy = net.proxyUrl || (net.useSystemProxy ? systemProxyUrl() : undefined)
  const key = `${proxy ?? ''}|${net.caCertPath}`
  if (cached && cached.key === key) return cached.dispatcher

  const ca = loadCa(net.caCertPath)
  const connect = ca ? { ca } : undefined

  let dispatcher: Dispatcher | undefined
  if (proxy) {
    dispatcher = new ProxyAgent({ uri: proxy, ...(connect ? { connect } : {}) })
  } else if (connect) {
    dispatcher = new Agent({ connect })
  } else {
    dispatcher = undefined
  }

  cached = { key, dispatcher }
  return dispatcher
}


export function getFetchOptions(): { dispatcher: Dispatcher } | undefined {
  const dispatcher = getOutboundDispatcher()
  return dispatcher ? { dispatcher } : undefined
}


export function resetOutboundDispatcher(): void {
  cached = null
}
