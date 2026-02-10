import { rendererLog } from './logger'

type RendererWindow = Window &
  typeof globalThis & {
    __craftRendererLoggingInstalled?: boolean
    __craftRendererConsoleOriginals?: Partial<Record<'log' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>>
  }

const LOG_LEVELS: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error']

function logToMain(label: string, ...args: unknown[]): void {
  window.electronAPI?.debugLog?.(label, ...args)
}

function logToRenderer(level: 'log' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
  if (level === 'error') {
    rendererLog.error(...args)
    return
  }
  if (level === 'warn') {
    rendererLog.warn(...args)
    return
  }
  rendererLog.info(...args)
}

export async function initRendererLogging(): Promise<void> {
  const globalWindow = window as RendererWindow
  if (globalWindow.__craftRendererLoggingInstalled) return

  const isDebug = await window.electronAPI?.isDebugMode?.()
  if (!isDebug) return

  globalWindow.__craftRendererLoggingInstalled = true
  globalWindow.__craftRendererConsoleOriginals = {}

  // Implements REQ-004: forward renderer errors + console output to the main log.
  for (const level of LOG_LEVELS) {
    const original = console[level].bind(console)
    globalWindow.__craftRendererConsoleOriginals[level] = original

    console[level] = (...args: unknown[]) => {
      original(...args)
      logToRenderer(level, ...args)
      logToMain(`[renderer:${level}]`, ...args)
    }
  }

  window.addEventListener('error', (event) => {
    const message = event.error ?? event.message
    logToRenderer('error', 'Window error:', message)
    logToMain('[renderer:error]', message)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason ?? 'unknown'
    logToRenderer('error', 'Unhandled rejection:', reason)
    logToMain('[renderer:unhandledrejection]', reason)
  })

  logToRenderer('info', 'Renderer logging enabled (debug mode)')
  logToMain('[renderer]', 'Renderer logging enabled (debug mode)')
}
