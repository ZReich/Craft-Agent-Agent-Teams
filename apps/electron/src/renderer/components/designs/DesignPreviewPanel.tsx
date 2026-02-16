/**
 * DesignPreviewPanel - Embedded webview for live design variant previews
 *
 * Uses Electron's <webview> tag (enabled via webviewTag: true in window-manager.ts)
 * to render design variants inline within the app, instead of requiring the user
 * to open an external browser.
 *
 * Features:
 * - Embedded webview with loading state
 * - Responsive device frame selector (desktop / tablet / mobile)
 * - Refresh, back, and external-open controls
 * - Error state with retry
 * - Variant selector tabs when multiple variants are present
 *
 * Implements REQ-009: Embedded Webview Preview Panel
 */

import * as React from 'react'
import { useState, useRef, useCallback, useEffect } from 'react'
import {
  ExternalLink,
  RefreshCw,
  Monitor,
  Tablet,
  Smartphone,
  Loader2,
  AlertCircle,
  Check,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a design variant for display in the preview panel */
interface PreviewVariant {
  id: string
  name: string
  previewUrl: string
  status: 'ready' | 'generating' | 'compiling' | 'error'
}

/** Device frame preset */
type DeviceFrame = 'desktop' | 'tablet' | 'mobile'

const DEVICE_FRAMES: Record<DeviceFrame, { width: string; label: string; icon: typeof Monitor }> = {
  desktop: { width: '100%', label: 'Desktop', icon: Monitor },
  tablet: { width: '768px', label: 'Tablet', icon: Tablet },
  mobile: { width: '375px', label: 'Mobile', icon: Smartphone },
}

export interface DesignPreviewPanelProps {
  /** Variants available for preview */
  variants: PreviewVariant[]
  /** Currently selected variant ID */
  selectedVariantId?: string
  /** Callback when user selects a variant from the tabs */
  onVariantSelect?: (variantId: string) => void
  /** Callback when user clicks "Use This Design" */
  onDesignSelect?: (variantId: string) => void
  /** Callback to open URL in external browser */
  onOpenExternal?: (url: string) => void
  /** Whether the panel is in expanded (full-width) mode */
  expanded?: boolean
  /** Toggle expanded mode */
  onToggleExpand?: () => void
  /** Optional className */
  className?: string
}

// ── Webview State ────────────────────────────────────────────────────────────

type WebviewState = 'loading' | 'ready' | 'error'

// ── Main Component ───────────────────────────────────────────────────────────

export function DesignPreviewPanel({
  variants,
  selectedVariantId,
  onVariantSelect,
  onDesignSelect,
  onOpenExternal,
  expanded = false,
  onToggleExpand,
  className,
}: DesignPreviewPanelProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [deviceFrame, setDeviceFrame] = useState<DeviceFrame>('desktop')
  const [webviewState, setWebviewState] = useState<WebviewState>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Current variant to preview
  const activeVariant = variants.find(v => v.id === selectedVariantId) ?? variants.find(v => v.status === 'ready')
  const readyVariants = variants.filter(v => v.status === 'ready')

  // ── Webview Event Handlers ──────────────────────────────────────────────

  const handleDidFinishLoad = useCallback(() => {
    setWebviewState('ready')
    setErrorMessage(null)
  }, [])

  const handleDidFailLoad = useCallback((_event: Electron.DidFailLoadEvent) => {
    setWebviewState('error')
    setErrorMessage('Failed to load preview. The dev server may not be running.')
  }, [])

  const handleRefresh = useCallback(() => {
    if (webviewRef.current) {
      setWebviewState('loading')
      setErrorMessage(null)
      webviewRef.current.reload()
    }
  }, [])

  const handleOpenExternal = useCallback(() => {
    if (activeVariant?.previewUrl && onOpenExternal) {
      onOpenExternal(activeVariant.previewUrl)
    }
  }, [activeVariant, onOpenExternal])

  // Attach webview event listeners
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    webview.addEventListener('did-finish-load', handleDidFinishLoad)
    webview.addEventListener('did-fail-load', handleDidFailLoad as EventListener)

    // Handle navigation within the webview (e.g., clicking links)
    const handleNewWindow = (event: Event) => {
      const e = event as Electron.NewWindowEvent
      // Open external links in the user's browser, not in the webview
      if (onOpenExternal && e.url) {
        e.preventDefault()
        onOpenExternal(e.url)
      }
    }
    webview.addEventListener('new-window', handleNewWindow)

    return () => {
      webview.removeEventListener('did-finish-load', handleDidFinishLoad)
      webview.removeEventListener('did-fail-load', handleDidFailLoad as EventListener)
      webview.removeEventListener('new-window', handleNewWindow)
    }
  }, [handleDidFinishLoad, handleDidFailLoad, onOpenExternal])

  // Reset loading state when URL changes
  useEffect(() => {
    if (activeVariant?.previewUrl) {
      setWebviewState('loading')
      setErrorMessage(null)
    }
  }, [activeVariant?.previewUrl])

  // ── Render ──────────────────────────────────────────────────────────────

  if (readyVariants.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full text-muted-foreground', className)}>
        <Loader2 className="h-6 w-6 animate-spin mb-2" />
        <p className="text-sm">Waiting for design variants to compile...</p>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        {/* Left: Variant tabs */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {readyVariants.map(variant => (
            <button
              key={variant.id}
              onClick={() => onVariantSelect?.(variant.id)}
              className={cn(
                'px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                variant.id === activeVariant?.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
            >
              {variant.name}
            </button>
          ))}
        </div>

        {/* Right: Controls */}
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {/* Device frame selector */}
          {(Object.entries(DEVICE_FRAMES) as [DeviceFrame, typeof DEVICE_FRAMES[DeviceFrame]][]).map(
            ([frame, config]) => {
              const Icon = config.icon
              return (
                <button
                  key={frame}
                  onClick={() => setDeviceFrame(frame)}
                  title={config.label}
                  className={cn(
                    'p-1.5 rounded-md transition-colors',
                    frame === deviceFrame
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            },
          )}

          <div className="w-px h-4 bg-border mx-1" />

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            title="Refresh preview"
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', webviewState === 'loading' && 'animate-spin')} />
          </button>

          {/* Open external */}
          <button
            onClick={handleOpenExternal}
            title="Open in browser"
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>

          {/* Expand/collapse */}
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              title={expanded ? 'Collapse' : 'Expand'}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Webview container */}
      <div className="flex-1 flex items-start justify-center overflow-auto bg-muted/30 p-4">
        <div
          className="relative bg-background border border-border rounded-lg overflow-hidden shadow-sm transition-all duration-300"
          style={{
            width: DEVICE_FRAMES[deviceFrame].width,
            maxWidth: '100%',
            height: deviceFrame === 'desktop' ? '100%' : deviceFrame === 'tablet' ? '1024px' : '812px',
          }}
        >
          {/* Loading overlay */}
          {webviewState === 'loading' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-2" />
              <p className="text-xs text-muted-foreground">Loading preview...</p>
            </div>
          )}

          {/* Error state */}
          {webviewState === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background z-10">
              <AlertCircle className="h-8 w-8 text-red-400 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">Preview unavailable</p>
              <p className="text-xs text-muted-foreground/70 mb-4 max-w-xs text-center">
                {errorMessage || 'Could not load the preview.'}
              </p>
              <button
                onClick={handleRefresh}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          )}

          {/* Webview — Electron's <webview> tag */}
          {activeVariant?.previewUrl && (
            <webview
              ref={webviewRef as React.RefObject<Electron.WebviewTag>}
              src={activeVariant.previewUrl}
              className="w-full h-full"
              // @ts-expect-error — Electron webview attributes not in React HTMLAttributes
              allowpopups="false"
              // @ts-expect-error — Electron webview attributes
              nodeintegration="false"
            />
          )}
        </div>
      </div>

      {/* Bottom bar: Selection action */}
      {activeVariant && onDesignSelect && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{activeVariant.name}</span>
            <span>&middot;</span>
            <span>{activeVariant.previewUrl}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onDesignSelect(activeVariant.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors"
            >
              <Check className="h-3 w-3" />
              Use This Design
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
