/**
 * MarkdownDesignGridBlock - Interactive design variant grid for ```designgrid code blocks
 *
 * Renders design variants as a responsive card grid (2×2 on desktop, 1-column on mobile).
 * Each card shows variant name, direction description, and build status.
 * Actions: "Open Live Build" (opens URL), "Use This Design" (selection callback),
 * and "Generate 4 More" (regeneration).
 *
 * Expected JSON shape:
 * {
 *   "sessionId": "abc-123",
 *   "variants": [
 *     {
 *       "id": "dv-abc",
 *       "name": "Minimal",
 *       "direction": "Clean, spacious...",
 *       "status": "ready",
 *       "previewUrl": "http://localhost:3000/design-preview/variant-abc",
 *       "error": null
 *     }
 *   ],
 *   "round": 1,
 *   "selectedId": null
 * }
 *
 * Falls back to CodeBlock if JSON parsing fails.
 *
 * Implements REQ-006: Design Grid Chat Block
 */

import * as React from 'react'
import {
  ExternalLink,
  Check,
  Loader2,
  AlertCircle,
  RefreshCw,
  Palette,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'

// ── Types ────────────────────────────────────────────────────────────────────

interface DesignVariantSummary {
  id: string
  name: string
  direction: string
  status: 'generating' | 'compiling' | 'ready' | 'error'
  previewUrl: string | null
  error: string | null
}

interface DesignGridData {
  sessionId: string
  variants: DesignVariantSummary[]
  round: number
  selectedId: string | null
}

export interface MarkdownDesignGridBlockProps {
  code: string
  className?: string
  /** Called when user selects a variant */
  onSelect?: (variantId: string) => void
  /** Called when user clicks "Open Live Build" */
  onPreview?: (variantId: string, url: string) => void
  /** Called when user clicks "Generate More" */
  onGenerateMore?: () => void
}

// ── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DesignVariantSummary['status'] }) {
  const config = {
    generating: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      label: 'Generating',
      className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    },
    compiling: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      label: 'Compiling',
      className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    },
    ready: {
      icon: <Check className="h-3 w-3" />,
      label: 'Ready',
      className: 'bg-green-500/10 text-green-400 border-green-500/20',
    },
    error: {
      icon: <AlertCircle className="h-3 w-3" />,
      label: 'Error',
      className: 'bg-red-500/10 text-red-400 border-red-500/20',
    },
  }[status]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border',
        config.className
      )}
    >
      {config.icon}
      {config.label}
    </span>
  )
}

// ── Variant Card ─────────────────────────────────────────────────────────────

interface VariantCardProps {
  variant: DesignVariantSummary
  isSelected: boolean
  onSelect?: () => void
  onPreview?: () => void
}

function VariantCard({ variant, isSelected, onSelect, onPreview }: VariantCardProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-lg border p-4 transition-all',
        isSelected
          ? 'border-green-500 bg-green-500/5 ring-1 ring-green-500/30'
          : 'border-border bg-card hover:border-foreground/20',
        variant.status === 'error' && 'border-red-500/30 bg-red-500/5',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-sm">{variant.name}</span>
        </div>
        <StatusBadge status={variant.status} />
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed mb-3 flex-1 line-clamp-3">
        {variant.direction}
      </p>

      {/* Error message */}
      {variant.status === 'error' && variant.error && (
        <div className="text-xs text-red-400 bg-red-500/5 rounded p-2 mb-3 font-mono line-clamp-2">
          {variant.error}
        </div>
      )}

      {/* Selected indicator */}
      {isSelected && (
        <div className="flex items-center gap-1.5 text-xs text-green-400 font-medium mb-3">
          <Check className="h-3.5 w-3.5" />
          Selected
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto">
        {variant.status === 'ready' && variant.previewUrl && (
          <button
            onClick={onPreview}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Open Live Build
          </button>
        )}
        {variant.status === 'ready' && !isSelected && (
          <button
            onClick={onSelect}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors"
          >
            <Check className="h-3 w-3" />
            Use This Design
          </button>
        )}
        {variant.status === 'generating' || variant.status === 'compiling' ? (
          <div className="flex-1 flex items-center justify-center py-1.5">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function MarkdownDesignGridBlock({
  code,
  className,
  onSelect,
  onPreview,
  onGenerateMore,
}: MarkdownDesignGridBlockProps) {
  // Parse JSON data
  let data: DesignGridData | null = null
  try {
    data = JSON.parse(code)
  } catch {
    // Fall back to code block on parse failure
  }

  if (!data || !Array.isArray(data.variants)) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const hasReadyVariants = data.variants.some(v => v.status === 'ready')
  const allGenerating = data.variants.every(v => v.status === 'generating' || v.status === 'compiling')

  return (
    <div className={cn('my-3', className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">
            Design Variants
            {data.round > 1 && (
              <span className="text-muted-foreground font-normal ml-1">(Round {data.round})</span>
            )}
          </span>
        </div>
        {hasReadyVariants && !data.selectedId && onGenerateMore && (
          <button
            onClick={onGenerateMore}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Generate More
          </button>
        )}
      </div>

      {/* Loading skeleton */}
      {allGenerating && (
        <div className="text-center py-6 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Generating {data.variants.length} design variants...
        </div>
      )}

      {/* Grid */}
      {!allGenerating && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.variants.map(variant => (
            <VariantCard
              key={variant.id}
              variant={variant}
              isSelected={data!.selectedId === variant.id}
              onSelect={onSelect ? () => onSelect(variant.id) : undefined}
              onPreview={
                onPreview && variant.previewUrl
                  ? () => onPreview(variant.id, variant.previewUrl!)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {data.variants.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
          No design variants generated yet.
        </div>
      )}
    </div>
  )
}
