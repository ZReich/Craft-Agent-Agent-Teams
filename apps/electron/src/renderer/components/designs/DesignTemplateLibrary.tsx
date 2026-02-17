/**
 * DesignTemplateLibrary - Browse and manage saved design templates
 *
 * Displays a searchable, filterable list of design templates saved from
 * previous design flow sessions. Users can preview template details,
 * check compatibility with the current project, and apply or delete templates.
 *
 * Template data is loaded via IPC from the workspace's design-templates/ directory
 * (managed by design-store.ts).
 *
 * Implements REQ-012: Design Template Browser
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import {
  Palette,
  Search,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  ChevronRight,
  FileCode2,
  Clock,
  Layers,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a template for the list view */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  direction: string
  framework: string | null
  typescript: boolean
  fileCount: number
  createdAt: string
  /** Whether this template is compatible with the current project stack */
  compatible: boolean
  /** Reason for incompatibility (if any) */
  incompatibleReason?: string
}

/** Full template detail (loaded on expand/preview) */
export interface TemplateDetail {
  id: string
  name: string
  description: string
  direction: string
  brief: string
  componentSpec: string
  files: Array<{ path: string; content: string }>
  stackRequirements: {
    framework: string | null
    typescript: boolean
    requiredDeps: string[]
  }
  createdAt: string
  sourceSessionId: string
  sourceTeamId: string
}

export interface DesignTemplateLibraryProps {
  /** List of template summaries */
  templates: TemplateSummary[]
  /** Whether templates are currently loading */
  loading?: boolean
  /** Callback to load a template's full details */
  onLoadDetail?: (templateId: string) => Promise<TemplateDetail | null>
  /** Callback when user clicks "Apply Template" */
  onApply?: (templateId: string) => void
  /** Callback when user clicks "Delete Template" */
  onDelete?: (templateId: string) => void
  /** Optional className */
  className?: string
}

// ── Template Card ────────────────────────────────────────────────────────────

interface TemplateCardProps {
  template: TemplateSummary
  isExpanded: boolean
  detail: TemplateDetail | null
  detailLoading: boolean
  onToggleExpand: () => void
  onApply?: () => void
  onDelete?: () => void
}

function TemplateCard({
  template,
  isExpanded,
  detail,
  detailLoading,
  onToggleExpand,
  onApply,
  onDelete,
}: TemplateCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div
      className={cn(
        'border border-border rounded-lg overflow-hidden transition-all',
        isExpanded ? 'bg-card' : 'bg-card hover:border-foreground/20',
      )}
    >
      {/* Header — always visible */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground shrink-0 transition-transform',
            isExpanded && 'rotate-90',
          )}
        />
        <Palette className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{template.name}</span>
            {!template.compatible && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                <AlertTriangle className="h-2.5 w-2.5" />
                Incompatible
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {template.direction}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span className="flex items-center gap-1">
            <FileCode2 className="h-3 w-3" />
            {template.fileCount}
          </span>
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {template.framework ?? 'vanilla'}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(template.createdAt).toLocaleDateString()}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-3">
          {detailLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Loading template details...</div>
          ) : detail ? (
            <div className="space-y-3">
              {/* Brief */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1">Design Brief</h4>
                <p className="text-xs text-foreground/80 leading-relaxed line-clamp-4">{detail.brief}</p>
              </div>

              {/* Component Spec */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1">Component Spec</h4>
                <p className="text-xs text-foreground/80 leading-relaxed line-clamp-3">{detail.componentSpec}</p>
              </div>

              {/* Files */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1">
                  Files ({detail.files.length})
                </h4>
                <div className="flex flex-wrap gap-1">
                  {detail.files.slice(0, 6).map(file => (
                    <span
                      key={file.path}
                      className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded"
                    >
                      {file.path}
                    </span>
                  ))}
                  {detail.files.length > 6 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      +{detail.files.length - 6} more
                    </span>
                  )}
                </div>
              </div>

              {/* Stack Requirements */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1">Stack Requirements</h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.stackRequirements.framework && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-400 rounded">
                      {detail.stackRequirements.framework}
                    </span>
                  )}
                  {detail.stackRequirements.typescript && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-400 rounded">
                      TypeScript
                    </span>
                  )}
                  {detail.stackRequirements.requiredDeps.map(dep => (
                    <span
                      key={dep}
                      className="px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground rounded"
                    >
                      {dep}
                    </span>
                  ))}
                </div>
              </div>

              {/* Incompatibility warning */}
              {!template.compatible && template.incompatibleReason && (
                <div className="flex items-start gap-2 p-2 bg-yellow-500/5 border border-yellow-500/20 rounded-md">
                  <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-yellow-400">{template.incompatibleReason}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                {onApply && (
                  <button
                    onClick={onApply}
                    disabled={!template.compatible}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                      template.compatible
                        ? 'bg-foreground text-background hover:bg-foreground/90'
                        : 'bg-muted text-muted-foreground cursor-not-allowed',
                    )}
                  >
                    <Copy className="h-3 w-3" />
                    Apply Template
                  </button>
                )}
                {onDelete && (
                  confirmDelete ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-red-400">Delete?</span>
                      <button
                        onClick={() => { onDelete(); setConfirmDelete(false) }}
                        className="p-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="p-1 rounded-md text-muted-foreground hover:bg-muted transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-muted-foreground hover:text-red-400 hover:border-red-500/30 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  )
                )}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-4 text-center">
              Could not load template details.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function DesignTemplateLibrary({
  templates,
  loading = false,
  onLoadDetail,
  onApply,
  onDelete,
  className,
}: DesignTemplateLibraryProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Map<string, TemplateDetail | null>>(new Map())
  const [detailLoading, setDetailLoading] = useState<string | null>(null)

  // Filter templates by search query
  const filteredTemplates = useMemo(() => {
    if (!searchQuery) return templates
    const q = searchQuery.toLowerCase()
    return templates.filter(
      t =>
        t.name.toLowerCase().includes(q) ||
        t.direction.toLowerCase().includes(q) ||
        (t.framework && t.framework.toLowerCase().includes(q)),
    )
  }, [templates, searchQuery])

  // Handle expanding a template — load detail if not cached
  const handleToggleExpand = async (templateId: string) => {
    if (expandedId === templateId) {
      setExpandedId(null)
      return
    }
    setExpandedId(templateId)

    if (!detailCache.has(templateId) && onLoadDetail) {
      setDetailLoading(templateId)
      const detail = await onLoadDetail(templateId)
      setDetailCache(prev => new Map(prev).set(templateId, detail))
      setDetailLoading(null)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Design Templates</span>
          <span className="text-xs text-muted-foreground">({templates.length})</span>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-border shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search templates..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* Template list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            Loading templates...
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            {searchQuery
              ? `No templates matching "${searchQuery}"`
              : 'No design templates saved yet. Templates are created automatically when you select a design variant.'}
          </div>
        ) : (
          filteredTemplates.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              isExpanded={expandedId === template.id}
              detail={detailCache.get(template.id) ?? null}
              detailLoading={detailLoading === template.id}
              onToggleExpand={() => handleToggleExpand(template.id)}
              onApply={onApply ? () => onApply(template.id) : undefined}
              onDelete={onDelete ? () => onDelete(template.id) : undefined}
            />
          ))
        )}
      </div>
    </div>
  )
}
