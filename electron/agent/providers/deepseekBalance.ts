import { getOutboundDispatcher } from './network'
import { normalizeBaseUrl } from './base'


export interface DeepSeekBalance {
  available: boolean
  total?: string
  currency?: string
}


function toBalanceUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  const root = normalized.replace(/\/(v1|beta|anthropic)$/i, '')
  return `${root}/user/balance`
}



export async function queryDeepSeekBalance(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<DeepSeekBalance | null> {
  try {
    const dispatcher = getOutboundDispatcher()
    const res = await fetch(toBalanceUrl(baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      },
      signal,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {})
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: string; total_balance?: string }>
    }
    const info = data.balance_infos?.[0]
    return {
      available: data.is_available === true,
      total: info?.total_balance,
      currency: info?.currency
    }
  } catch {
    return null
  }
}
