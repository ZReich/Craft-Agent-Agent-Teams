/**
 * QuickFilters
 *
 * Compact horizontal filter bar for filtering tasks and requirements
 * by DRI, requirement, ticket, teammate, and status.
 */

import * as React from 'react'
import { X, User, FileCheck2, Users, CircleDot, Ticket } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface QuickFilterState {
  dri?: string
  requirementId?: string
  ticketId?: string
  teammateId?: string
  status?: string
}

export interface QuickFiltersProps {
  filters: QuickFilterState
  onFiltersChange: (filters: QuickFilterState) => void
  driOptions: string[]
  requirementOptions: Array<{ id: string; description: string }>
  teammateOptions: Array<{ id: string; name: string }>
  ticketOptions?: Array<{ id: string; title: string; provider: string }>
  className?: string
}

const EMPTY_FILTERS: QuickFilterState = {}

function hasActiveFilters(filters: QuickFilterState): boolean {
  return Boolean(filters.dri || filters.requirementId || filters.ticketId || filters.teammateId || filters.status)
}

interface FilterPillProps {
  icon: React.ReactNode
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
}

function FilterPill({ icon, label, value, options, onChange }: FilterPillProps) {
  if (options.length === 0) return null

  return (
    <div className="relative flex items-center">
      {value ? (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/20 text-accent text-[11px] font-medium hover:bg-accent/30 transition-colors"
        >
          {icon}
          <span className="max-w-[80px] truncate">{value}</span>
          <X className="size-3 ml-0.5" />
        </button>
      ) : (
        <div className="relative">
          <select
            value=""
            onChange={(e) => onChange(e.target.value || undefined)}
            className="appearance-none bg-transparent text-[11px] text-muted-foreground pl-5 pr-4 py-0.5 rounded-md border border-transparent hover:border-border hover:text-foreground cursor-pointer transition-colors focus:outline-none focus:border-border"
          >
            <option value="">{label}</option>
            {options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none">
            {icon}
          </span>
        </div>
      )}
    </div>
  )
}

export function QuickFilters({
  filters,
  onFiltersChange,
  driOptions,
  requirementOptions,
  teammateOptions,
  ticketOptions = [],
  className,
}: QuickFiltersProps) {
  const update = (key: keyof QuickFilterState, value: string | undefined) => {
    onFiltersChange({ ...filters, [key]: value })
  }

  return (
    <div className={cn('flex items-center gap-1.5 px-2 py-1 min-h-[32px]', className)}>
      <FilterPill
        icon={<User className="size-3" />}
        label="DRI"
        value={filters.dri}
        options={driOptions.map(d => ({ value: d, label: d }))}
        onChange={(v) => update('dri', v)}
      />

      <FilterPill
        icon={<FileCheck2 className="size-3" />}
        label="Requirement"
        value={filters.requirementId}
        options={requirementOptions.map(r => ({ value: r.id, label: `${r.id}: ${r.description.slice(0, 40)}` }))}
        onChange={(v) => update('requirementId', v)}
      />

      <FilterPill
        icon={<Users className="size-3" />}
        label="Teammate"
        value={filters.teammateId ? teammateOptions.find(t => t.id === filters.teammateId)?.name : undefined}
        options={teammateOptions.map(t => ({ value: t.id, label: t.name }))}
        onChange={(v) => update('teammateId', v)}
      />

      {ticketOptions.length > 0 && (
        <FilterPill
          icon={<Ticket className="size-3" />}
          label="Ticket"
          value={filters.ticketId}
          options={ticketOptions.map(t => ({ value: t.id, label: `${t.provider}#${t.id}: ${t.title.slice(0, 30)}` }))}
          onChange={(v) => update('ticketId', v)}
        />
      )}

      <FilterPill
        icon={<CircleDot className="size-3" />}
        label="Status"
        value={filters.status}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'completed', label: 'Completed' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'failed', label: 'Failed' },
        ]}
        onChange={(v) => update('status', v)}
      />

      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onFiltersChange(EMPTY_FILTERS)}
          className="text-[10px] text-muted-foreground hover:text-foreground ml-1 underline underline-offset-2"
        >
          Clear all
        </button>
      )}
    </div>
  )
}
