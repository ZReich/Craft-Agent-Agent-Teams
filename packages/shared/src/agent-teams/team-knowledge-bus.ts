/**
 * Team Knowledge Bus
 *
 * Shared append-only memory for agent teams.
 *
 * Implements REQ-NEXT-001:
 * - shared episodic + semantic memory
 * - file/path + tag retrieval
 * - conflict registry
 * - lightweight prompt injection context builder (< ~500 tokens target)
 */

import { EventEmitter } from 'events'

export type KnowledgeEntryType =
  | 'discovery'
  | 'pattern'
  | 'decision'
  | 'warning'
  | 'interface-contract'

export interface ConflictWarning {
  id: string
  filePath: string
  teamId: string
  detectedAt: number
  editors: Array<{
    teammateId: string
    teammateName: string
    taskId?: string
  }>
  blocked: boolean
}

export interface KnowledgeEntry {
  id: string
  type: KnowledgeEntryType
  content: string
  source: string
  filePaths?: string[]
  tags: string[]
  timestamp: number
  ttl?: number
  linkedEntries?: string[]
  metadata?: {
    conflict?: ConflictWarning
    [key: string]: unknown
  }
}

export type KnowledgeEntryInput = Omit<KnowledgeEntry, 'id' | 'timestamp'>

export interface KnowledgeFilter {
  types?: KnowledgeEntryType[]
  tagsAny?: string[]
  source?: string
  filePath?: string
}

interface ActiveEditor {
  teammateId: string
  teammateName: string
  taskId?: string
  lastSeen: number
}

interface PromptSignals {
  pathMatches: string[]
  keywordMatches: string[]
}

const DEFAULT_MAX_ENTRIES = 5_000
const DEFAULT_MAX_CONFLICTS_PER_FILE = 100
const EDIT_CONFLICT_WINDOW_MS = 30_000
const MAX_ENTRY_CONTENT_CHARS = 2_000
const CHARS_PER_TOKEN_ESTIMATE = 4
const DEFAULT_INJECTION_TOKEN_BUDGET = 500

function normalizePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/')
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase()
}

function normalizePathLookupKey(pathValue: string): string {
  return normalizePath(pathValue).replace(/^\.\//, '').replace(/^\/+/, '')
}

function buildPathLookupKeys(filePath: string): string[] {
  const normalized = normalizePathLookupKey(filePath)
  if (!normalized) return []

  const keys = new Set<string>([normalized])
  const segments = normalized.split('/').filter(Boolean)
  for (let index = 1; index < segments.length; index++) {
    keys.add(segments.slice(index).join('/'))
  }
  return Array.from(keys)
}

function queryTerms(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_-]+/g)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
        .filter((part) => !['with', 'from', 'this', 'that', 'what', 'where', 'when'].includes(part)),
    ),
  )
}

function createKnowledgeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function compactContent(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= MAX_ENTRY_CONTENT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_ENTRY_CONTENT_CHARS)}...`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

function normalizeFilePaths(filePaths?: string[]): string[] {
  return Array.from(
    new Set(
      (filePaths || [])
        .map((path) => normalizePath(path))
        .filter(Boolean),
    ),
  )
}

function normalizeTags(tags?: string[]): string[] {
  return Array.from(
    new Set(
      (tags || [])
        .map((tag) => normalizeTag(tag))
        .filter(Boolean),
    ),
  )
}

/**
 * Per-team in-memory knowledge bus.
 */
export class TeamKnowledgeBus extends EventEmitter {
  private readonly teamId: string
  private readonly maxEntries: number
  private readonly entries: KnowledgeEntry[] = []
  private readonly idIndex: Map<string, KnowledgeEntry> = new Map()
  private readonly tagIndex: Map<string, Set<string>> = new Map()
  private readonly pathLookupIndex: Map<string, Set<string>> = new Map()
  private readonly conflictRegistry: Map<string, ConflictWarning[]> = new Map()
  private readonly activeEditors: Map<string, Map<string, ActiveEditor>> = new Map()
  private readonly subscriptions: Array<{ filter: KnowledgeFilter; cb: (entry: KnowledgeEntry) => void }> = []

  constructor(teamId: string, options?: { maxEntries?: number }) {
    super()
    this.teamId = teamId
    this.maxEntries = Math.max(100, options?.maxEntries ?? DEFAULT_MAX_ENTRIES)
  }

  publish(entry: KnowledgeEntryInput): string {
    this.pruneExpired()

    const knowledgeEntry: KnowledgeEntry = {
      id: createKnowledgeId('kb'),
      type: entry.type,
      content: compactContent(entry.content),
      source: entry.source,
      filePaths: normalizeFilePaths(entry.filePaths),
      tags: normalizeTags(entry.tags),
      timestamp: Date.now(),
      ttl: entry.ttl,
      linkedEntries: entry.linkedEntries,
      metadata: entry.metadata,
    }

    if ((knowledgeEntry.filePaths?.length ?? 0) === 0) {
      delete knowledgeEntry.filePaths
    }

    this.addEntry(knowledgeEntry)
    return knowledgeEntry.id
  }

  /**
   * Rehydrate a previously persisted entry without altering its identity/timestamp.
   */
  publishHydrated(entry: KnowledgeEntry): void {
    if (!entry || !entry.id) return
    if (this.idIndex.has(entry.id)) return
    if (entry.ttl && entry.timestamp + entry.ttl <= Date.now()) return

    const hydrated: KnowledgeEntry = {
      ...entry,
      filePaths: normalizeFilePaths(entry.filePaths),
      tags: normalizeTags(entry.tags),
      content: compactContent(entry.content),
    }
    this.addEntry(hydrated, { emit: false })
  }

  getById(entryId: string): KnowledgeEntry | undefined {
    return this.idIndex.get(entryId)
  }

  query(tags: string[], limit: number = 20): KnowledgeEntry[] {
    this.pruneExpired()
    const normalizedTags = tags.map((tag) => normalizeTag(tag)).filter(Boolean)
    if (normalizedTags.length === 0) {
      return this.entries.slice(-limit).reverse()
    }

    const matchedIds = new Set<string>()
    for (const tag of normalizedTags) {
      const ids = this.tagIndex.get(tag)
      if (!ids) continue
      for (const id of ids) matchedIds.add(id)
    }

    return this.getSortedEntriesFromIds(matchedIds).slice(0, Math.max(1, limit))
  }

  queryText(query: string, limit: number = 20): KnowledgeEntry[] {
    this.pruneExpired()
    const terms = queryTerms(query)
    if (terms.length === 0) {
      return this.entries.slice(-limit).reverse()
    }

    const ranked = this.entries
      .map((entry) => {
        const content = entry.content.toLowerCase()
        const source = entry.source.toLowerCase()
        const tags = entry.tags.join(' ')
        const filePaths = (entry.filePaths || []).join(' ').toLowerCase()
        let score = 0
        for (const term of terms) {
          if (content.includes(term)) score += 3
          if (tags.includes(term)) score += 4
          if (filePaths.includes(term)) score += 2
          if (source.includes(term)) score += 1
        }
        return { entry, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.entry.timestamp - a.entry.timestamp))

    return ranked.slice(0, Math.max(1, limit)).map((item) => item.entry)
  }

  queryByFile(filePath: string): KnowledgeEntry[] {
    this.pruneExpired()
    const matchedIds = new Set<string>()

    for (const key of buildPathLookupKeys(filePath)) {
      const ids = this.pathLookupIndex.get(key)
      if (!ids) continue
      for (const id of ids) matchedIds.add(id)
    }

    return this.getSortedEntriesFromIds(matchedIds)
  }

  getConflicts(filePath: string): ConflictWarning[] {
    const normalized = normalizePath(filePath)
    const exact = this.conflictRegistry.get(normalized) ?? []
    if (exact.length > 0) return [...exact]

    const merged: ConflictWarning[] = []
    for (const [indexedPath, conflicts] of this.conflictRegistry.entries()) {
      if (indexedPath.endsWith(normalized) || normalized.endsWith(indexedPath)) {
        merged.push(...conflicts)
      }
    }
    return merged.sort((a, b) => b.detectedAt - a.detectedAt)
  }

  subscribe(filter: KnowledgeFilter, cb: (entry: KnowledgeEntry) => void): void {
    this.subscriptions.push({ filter, cb })
  }

  /**
   * Record active file edits and detect overlaps within a 30s window.
   */
  recordFileEdit(params: {
    filePath: string
    teammateId: string
    teammateName: string
    taskId?: string
  }): { conflict: ConflictWarning | null; warningEntry?: KnowledgeEntry } {
    const now = Date.now()
    const normalizedPath = normalizePath(params.filePath)

    const participants = this.trackActiveEditorsAndCollectParticipants(normalizedPath, params, now)
    if (participants.length <= 1) {
      return { conflict: null }
    }

    const recentConflict = this.findRecentConflict(normalizedPath, participants, now)
    if (recentConflict) {
      return { conflict: recentConflict }
    }

    const conflict = this.createConflict(normalizedPath, participants, now)
    const warningEntry = this.publishConflictWarning(conflict)

    return { conflict, warningEntry }
  }

  /**
   * Build a compact knowledge block for task prompt injection.
   * REQ-NEXT-001 acceptance guardrail: keep injected context under token budget.
   */
  buildPromptContext(taskPrompt: string, options?: { maxChars?: number; maxEntries?: number; maxTokens?: number }): string {
    this.pruneExpired()

    const maxChars = Math.max(300, options?.maxChars ?? 1_800)
    const maxEntries = Math.max(1, options?.maxEntries ?? 8)
    const maxTokens = Math.max(80, options?.maxTokens ?? DEFAULT_INJECTION_TOKEN_BUDGET)

    const signals = this.extractPromptSignals(taskPrompt)
    const candidates = this.collectPromptCandidates(signals, maxEntries)

    if (candidates.length === 0) return ''
    return this.formatPromptContext(candidates, maxEntries, maxChars, maxTokens)
  }

  clear(): void {
    this.entries.length = 0
    this.idIndex.clear()
    this.tagIndex.clear()
    this.pathLookupIndex.clear()
    this.conflictRegistry.clear()
    this.activeEditors.clear()
    this.subscriptions.length = 0
    this.removeAllListeners()
  }

  private extractPromptSignals(taskPrompt: string): PromptSignals {
    const pathMatches = Array.from(
      new Set(
        (taskPrompt.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g) ?? [])
          .map((value) => normalizePath(value)),
      ),
    ).slice(0, 8)

    const keywordMatches = Array.from(
      new Set(
        (taskPrompt.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
          .filter((word) => !['task', 'team', 'with', 'from', 'that', 'this', 'into', 'when'].includes(word)),
      ),
    ).slice(0, 12)

    return { pathMatches, keywordMatches }
  }

  private collectPromptCandidates(signals: PromptSignals, maxEntries: number): KnowledgeEntry[] {
    const candidates: KnowledgeEntry[] = []
    const seen = new Set<string>()

    for (const filePath of signals.pathMatches) {
      for (const entry of this.queryByFile(filePath)) {
        this.tryAddPromptCandidate(entry, candidates, seen)
      }
    }

    for (const entry of this.query(signals.keywordMatches, maxEntries * 2)) {
      this.tryAddPromptCandidate(entry, candidates, seen)
    }

    for (const entry of this.entries.slice(-maxEntries * 2).reverse()) {
      this.tryAddPromptCandidate(entry, candidates, seen)
    }

    return candidates
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxEntries)
  }

  private tryAddPromptCandidate(entry: KnowledgeEntry, candidates: KnowledgeEntry[], seen: Set<string>): void {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    candidates.push(entry)
  }

  private formatPromptContext(entries: KnowledgeEntry[], maxEntries: number, maxChars: number, maxTokens: number): string {
    const sorted = entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxEntries)

    const header = '[Team Knowledge Bus Context]\nUse this shared memory before re-reading files:\n'
    const lines: string[] = []

    for (const entry of sorted) {
      const fileSuffix = entry.filePaths?.length
        ? ` (files: ${entry.filePaths.slice(0, 2).join(', ')})`
        : ''
      const line = `- [${entry.type}] ${entry.source}: ${entry.content}${fileSuffix}\n`
      const nextBlock = `${header}${lines.join('')}${line}`
      if (nextBlock.length > maxChars) break
      if (estimateTokens(nextBlock) > maxTokens) break
      lines.push(line)
    }

    if (lines.length === 0) return ''
    return `${header}${lines.join('')}`.trim()
  }

  private trackActiveEditorsAndCollectParticipants(
    normalizedPath: string,
    params: { teammateId: string; teammateName: string; taskId?: string },
    now: number,
  ): ConflictWarning['editors'] {
    this.pruneActiveEditors(now)

    const editorsByFile = this.activeEditors.get(normalizedPath) ?? new Map<string, ActiveEditor>()
    const otherEditors = Array.from(editorsByFile.values())
      .filter((editor) => editor.teammateId !== params.teammateId && now - editor.lastSeen <= EDIT_CONFLICT_WINDOW_MS)

    editorsByFile.set(params.teammateId, {
      teammateId: params.teammateId,
      teammateName: params.teammateName,
      taskId: params.taskId,
      lastSeen: now,
    })
    this.activeEditors.set(normalizedPath, editorsByFile)

    return [
      ...otherEditors.map((editor) => ({
        teammateId: editor.teammateId,
        teammateName: editor.teammateName,
        taskId: editor.taskId,
      })),
      {
        teammateId: params.teammateId,
        teammateName: params.teammateName,
        taskId: params.taskId,
      },
    ]
  }

  private findRecentConflict(normalizedPath: string, participants: ConflictWarning['editors'], now: number): ConflictWarning | null {
    const latestConflict = (this.conflictRegistry.get(normalizedPath) ?? []).slice(-1)[0]
    if (!latestConflict || now - latestConflict.detectedAt > EDIT_CONFLICT_WINDOW_MS) {
      return null
    }

    const recentParticipants = new Set(latestConflict.editors.map((editor) => editor.teammateId))
    const nextParticipants = new Set(participants.map((editor) => editor.teammateId))
    const sameParticipants = recentParticipants.size === nextParticipants.size
      && Array.from(recentParticipants).every((id) => nextParticipants.has(id))

    return sameParticipants ? latestConflict : null
  }

  private createConflict(
    normalizedPath: string,
    participants: ConflictWarning['editors'],
    now: number,
  ): ConflictWarning {
    const conflict: ConflictWarning = {
      id: createKnowledgeId('conflict'),
      filePath: normalizedPath,
      teamId: this.teamId,
      detectedAt: now,
      editors: participants,
      blocked: false,
    }
    this.registerConflict(conflict)
    return conflict
  }

  private publishConflictWarning(conflict: ConflictWarning): KnowledgeEntry | undefined {
    const warningContent = `Concurrent edit detected on ${conflict.filePath} by ${conflict.editors.map((editor) => editor.teammateName).join(', ')}`
    const warningId = this.publish({
      type: 'warning',
      content: warningContent,
      source: 'team-knowledge-bus',
      filePaths: [conflict.filePath],
      tags: ['conflict', 'file-overlap', ...conflict.editors.map((editor) => normalizeTag(editor.teammateName))],
      metadata: { conflict },
    })
    return this.idIndex.get(warningId)
  }

  private getSortedEntriesFromIds(ids: Set<string>): KnowledgeEntry[] {
    return Array.from(ids)
      .map((id) => this.idIndex.get(id))
      .filter((entry): entry is KnowledgeEntry => Boolean(entry))
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  private addEntry(entry: KnowledgeEntry, options?: { emit?: boolean }): void {
    this.entries.push(entry)
    this.idIndex.set(entry.id, entry)

    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set())
      this.tagIndex.get(tag)!.add(entry.id)
    }

    for (const filePath of entry.filePaths || []) {
      for (const key of buildPathLookupKeys(filePath)) {
        if (!this.pathLookupIndex.has(key)) this.pathLookupIndex.set(key, new Set())
        this.pathLookupIndex.get(key)!.add(entry.id)
      }
    }

    if (entry.metadata?.conflict && entry.filePaths?.[0]) {
      this.registerConflict(entry.metadata.conflict)
    }

    this.evictOldestIfNeeded()

    if (options?.emit === false) return
    this.emit('entry', entry)
    for (const sub of this.subscriptions) {
      if (!this.matchesFilter(entry, sub.filter)) continue
      try {
        sub.cb(entry)
      } catch {
        // Knowledge bus should never crash the session due to subscriber failures.
      }
    }
  }

  private matchesFilter(entry: KnowledgeEntry, filter: KnowledgeFilter): boolean {
    if (filter.types && filter.types.length > 0 && !filter.types.includes(entry.type)) return false
    if (filter.source && entry.source !== filter.source) return false

    if (filter.tagsAny && filter.tagsAny.length > 0) {
      const desired = new Set(filter.tagsAny.map((tag) => normalizeTag(tag)))
      const hasAny = entry.tags.some((tag) => desired.has(tag))
      if (!hasAny) return false
    }

    if (filter.filePath) {
      const desiredKeys = new Set(buildPathLookupKeys(filter.filePath))
      const paths = entry.filePaths || []
      const matched = paths.some((path) => buildPathLookupKeys(path).some((key) => desiredKeys.has(key)))
      if (!matched) return false
    }

    return true
  }

  private pruneExpired(): void {
    const now = Date.now()
    const expiredIds = this.entries
      .filter((entry) => entry.ttl && entry.timestamp + entry.ttl <= now)
      .map((entry) => entry.id)
    if (expiredIds.length === 0) return

    for (const id of expiredIds) {
      this.removeEntry(id)
    }
  }

  private removeEntry(entryId: string): void {
    const entry = this.idIndex.get(entryId)
    if (!entry) return
    this.idIndex.delete(entryId)

    const idx = this.entries.findIndex((candidate) => candidate.id === entryId)
    if (idx >= 0) this.entries.splice(idx, 1)

    for (const tag of entry.tags) {
      const ids = this.tagIndex.get(tag)
      if (!ids) continue
      ids.delete(entryId)
      if (ids.size === 0) this.tagIndex.delete(tag)
    }

    for (const filePath of entry.filePaths || []) {
      for (const key of buildPathLookupKeys(filePath)) {
        const ids = this.pathLookupIndex.get(key)
        if (!ids) continue
        ids.delete(entryId)
        if (ids.size === 0) this.pathLookupIndex.delete(key)
      }
    }
  }

  private evictOldestIfNeeded(): void {
    if (this.entries.length <= this.maxEntries) return
    const overflow = this.entries.length - this.maxEntries
    const idsToRemove = this.entries.slice(0, overflow).map((entry) => entry.id)
    for (const id of idsToRemove) this.removeEntry(id)
  }

  private pruneActiveEditors(now: number): void {
    for (const [filePath, editors] of this.activeEditors.entries()) {
      for (const [editorId, editor] of editors.entries()) {
        if (now - editor.lastSeen > EDIT_CONFLICT_WINDOW_MS) {
          editors.delete(editorId)
        }
      }
      if (editors.size === 0) {
        this.activeEditors.delete(filePath)
      }
    }
  }

  private registerConflict(conflict: ConflictWarning): void {
    const normalizedPath = normalizePath(conflict.filePath)
    const conflictList = this.conflictRegistry.get(normalizedPath) ?? []
    if (conflictList.some((existing) => existing.id === conflict.id)) {
      return
    }
    conflictList.push(conflict)
    if (conflictList.length > DEFAULT_MAX_CONFLICTS_PER_FILE) {
      conflictList.splice(0, conflictList.length - DEFAULT_MAX_CONFLICTS_PER_FILE)
    }
    this.conflictRegistry.set(normalizedPath, conflictList)
  }
}
