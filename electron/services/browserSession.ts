import { randomUUID } from 'crypto'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'



export type BrowserSessionStatus = 'open' | 'closed'

export interface BrowserSession {
  id: string
  browser: Browser
  context: BrowserContext
  
  pages: Page[]
  activePageIndex: number
  status: BrowserSessionStatus
  
  agentSessionId?: string
  createdAt: number
  updatedAt: number
}

export interface OpenBrowserSessionOptions {
  agentSessionId?: string
  viewport?: { width: number; height: number }
  headless?: boolean
}

const sessions = new Map<string, BrowserSession>()


export function resolveChromiumExecutablePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined
  if (rawPath.includes('app.asar') && !rawPath.includes('app.asar.unpacked')) {
    return rawPath.replace('app.asar', 'app.asar.unpacked')
  }
  return rawPath
}

function chromiumExecutablePath(): string | undefined {
  try {
    return resolveChromiumExecutablePath(chromium.executablePath())
  } catch {
    return undefined
  }
}

function touch(session: BrowserSession): void {
  session.updatedAt = Date.now()
}


export async function openBrowserSession(options: OpenBrowserSessionOptions = {}): Promise<BrowserSession> {
  const executablePath = chromiumExecutablePath()
  const browser = await chromium.launch({
    headless: options.headless ?? false,
    ...(executablePath ? { executablePath } : {})
  })
  const context = await browser.newContext({
    ...(options.viewport ? { viewport: options.viewport } : {})
  })
  const page = await context.newPage()

  const now = Date.now()
  const session: BrowserSession = {
    id: `browser-${randomUUID()}`,
    browser,
    context,
    pages: [page],
    activePageIndex: 0,
    status: 'open',
    agentSessionId: options.agentSessionId,
    createdAt: now,
    updatedAt: now
  }
  sessions.set(session.id, session)
  return session
}

export function getBrowserSession(id: string): BrowserSession | undefined {
  return sessions.get(id)
}


export function getActivePage(id: string): Page | undefined {
  const session = sessions.get(id)
  if (!session || session.status !== 'open') return undefined
  
  const livePages = session.context.pages()
  session.pages = livePages
  if (livePages.length === 0) return undefined
  if (session.activePageIndex >= livePages.length || session.activePageIndex < 0) {
    session.activePageIndex = livePages.length - 1
  }
  touch(session)
  return livePages[session.activePageIndex]
}


export function refreshPages(id: string): Page[] {
  const session = sessions.get(id)
  if (!session) return []
  session.pages = session.context.pages()
  if (session.activePageIndex >= session.pages.length) {
    session.activePageIndex = Math.max(0, session.pages.length - 1)
  }
  touch(session)
  return session.pages
}

export function setActivePageIndex(id: string, index: number): boolean {
  const session = sessions.get(id)
  if (!session) return false
  const pages = refreshPages(id)
  if (index < 0 || index >= pages.length) return false
  session.activePageIndex = index
  touch(session)
  return true
}


export async function closePageAtIndex(id: string, index: number): Promise<boolean> {
  const session = sessions.get(id)
  if (!session || session.status !== 'open') return false
  const pages = refreshPages(id)
  if (index < 0 || index >= pages.length) return false

  const active = session.activePageIndex
  if (index < active) {
    session.activePageIndex = active - 1
  } else if (index === active) {
    if (pages.length === 1) {
      session.activePageIndex = 0
    } else if (index >= pages.length - 1) {
      session.activePageIndex = index - 1
    }
  }

  await pages[index].close()
  const remaining = refreshPages(id)
  if (remaining.length === 0) {
    await session.context.newPage()
    session.activePageIndex = 0
    refreshPages(id)
  }
  touch(session)
  return true
}


export async function closeBrowserSession(id: string): Promise<boolean> {
  const session = sessions.get(id)
  if (!session) return false
  session.status = 'closed'
  touch(session)
  try {
    await session.context.close()
  } catch {
    
  }
  try {
    await session.browser.close()
  } catch {
    
  }
  sessions.delete(id)
  return true
}

export function listBrowserSessions(): BrowserSession[] {
  return [...sessions.values()]
}


export async function closeBrowserSessionsForAgent(agentSessionId: string): Promise<void> {
  const targets = [...sessions.values()].filter((s) => s.agentSessionId === agentSessionId)
  await Promise.all(targets.map((s) => closeBrowserSession(s.id)))
}


export async function resetBrowserSessions(): Promise<void> {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map((id) => closeBrowserSession(id)))
  sessions.clear()
}
