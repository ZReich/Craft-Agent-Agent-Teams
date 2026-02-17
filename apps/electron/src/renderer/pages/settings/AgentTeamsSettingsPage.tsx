/**
 * AgentTeamsSettingsPage
 *
 * Settings page for the Agent Teams feature:
 * - Master toggle (opt-in, off by default)
 * - Model preset selection (Max Quality, Balanced, Cost Optimized, Budget, Custom)
 * - Per-role model assignment (Lead, Head, Worker, Escalation)
 * - Provider API key configuration
 * - Cost cap
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Info } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { Button } from '@/components/ui/button'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ModelPresetId, ModelAssignment, WorkspaceSettings } from '../../../shared/types'
import { OPENAI_MODELS, isCodexModel, getModelShortName } from '@config/models'
import { isOpenAIProvider } from '@config/llm-connections'
import { QUALITY_GATE_HELP, parseKnownFailingTests, stringifyKnownFailingTests } from './qualityGateHelp'
import { DesignTemplateLibrary, type TemplateSummary, type TemplateDetail } from '@/components/designs'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsMenuSelectRow,
  SettingsInput,
  SettingsTextarea,
  SettingsRadioGroup,
  SettingsRadioCard,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'agent-teams',
}

// Available models for role assignment (Claude + Kimi)
const BASE_MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Most capable ($15/$75 per 1M tokens)' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', description: 'Best balance ($3/$15 per 1M tokens)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest ($0.80/$4 per 1M tokens)' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5', description: 'Cost-effective worker ($1.50/$7.50 per 1M tokens)' },
]

const CODEX_MODEL_OPTIONS = OPENAI_MODELS.map((model) => ({
  value: model.id,
  label: model.name,
  description: `${model.description} (Codex)`,
}))


// Cost level for badge coloring
type CostLevel = 1 | 2 | 3 | 4

const COST_BADGE_COLORS: Record<CostLevel, string> = {
  1: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  2: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  3: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  4: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
}

// Role dot colors for the expanded grid
const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-violet-500',
  head: 'bg-blue-500',
  worker: 'bg-emerald-500',
  reviewer: 'bg-amber-500',
  escalation: 'bg-rose-500',
}

// Strategy configurations — 4 strategies replace the old 7 presets
const STRATEGY_OPTIONS: { id: ModelPresetId; name: string; description: string; badge?: string; cost: string; costLevel: CostLevel | 0 }[] = [
  { id: 'smart', name: 'Smart', badge: 'Recommended', description: 'Workers adapt to quality gates: Sonnet when QG on, Opus when off. Thinking auto-set per role.', cost: '$$$', costLevel: 3 },
  { id: 'codex', name: 'Codex', description: 'OpenAI Codex for planning, Claude workers. Thinking auto-set.', cost: '$$$', costLevel: 3 },
  { id: 'budget', name: 'Budget', description: 'Sonnet lead + Haiku workers. Thinking off. Lowest cost.', cost: '$', costLevel: 1 },
  { id: 'custom', name: 'Custom', description: 'Full control over model and thinking for every role.', cost: '', costLevel: 0 },
]

const STRATEGY_CONFIGS: Record<string, { lead: string; head: string; worker: string; reviewer: string; escalation: string }> = {
  'smart': { lead: 'claude-opus-4-6', head: 'claude-opus-4-6', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-opus-4-6', escalation: 'claude-opus-4-6' },
  'codex': { lead: 'gpt-5.3-codex', head: 'gpt-5.3-codex', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-haiku-4-5-20251001', escalation: 'gpt-5.3-codex' },
  'budget': { lead: 'claude-sonnet-4-5-20250929', head: 'claude-haiku-4-5-20251001', worker: 'claude-haiku-4-5-20251001', reviewer: 'claude-haiku-4-5-20251001', escalation: 'claude-sonnet-4-5-20250929' },
  'custom': { lead: 'claude-opus-4-6', head: 'claude-sonnet-4-5-20250929', worker: 'claude-haiku-4-5-20251001', reviewer: 'claude-haiku-4-5-20251001', escalation: 'claude-opus-4-6' },
  // Legacy migration targets — all map to smart
  'max-quality': { lead: 'claude-opus-4-6', head: 'claude-opus-4-6', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-opus-4-6', escalation: 'claude-opus-4-6' },
  'balanced': { lead: 'claude-opus-4-6', head: 'claude-opus-4-6', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-opus-4-6', escalation: 'claude-opus-4-6' },
  'cost-optimized': { lead: 'claude-opus-4-6', head: 'claude-opus-4-6', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-opus-4-6', escalation: 'claude-opus-4-6' },
  'codex-balanced': { lead: 'gpt-5.3-codex', head: 'gpt-5.3-codex', worker: 'claude-sonnet-4-5-20250929', reviewer: 'claude-haiku-4-5-20251001', escalation: 'claude-sonnet-4-5-20250929' },
  'codex-full': { lead: 'gpt-5.3-codex', head: 'gpt-5.3-codex', worker: 'gpt-5.1-codex-mini', reviewer: 'claude-haiku-4-5-20251001', escalation: 'gpt-5.3-codex' },
}

// Implements REQ-P3: Thinking auto-set per strategy (only visible in Custom mode)
const STRATEGY_THINKING: Record<string, Record<string, boolean>> = {
  smart:  { lead: true,  head: true,  worker: false, reviewer: true,  escalation: true  },
  codex:  { lead: false, head: false, worker: false, reviewer: true,  escalation: false },
  budget: { lead: false, head: false, worker: false, reviewer: false, escalation: false },
}

/** Migrate old 7-preset IDs to new 4-strategy IDs */
function migratePresetId(id: string): ModelPresetId {
  switch (id) {
    case 'max-quality':
    case 'balanced':
    case 'cost-optimized':
      return 'smart'
    case 'codex-balanced':
    case 'codex-full':
      return 'codex'
    case 'budget':
      return 'budget'
    case 'custom':
      return 'custom'
    default:
      return 'smart'
  }
}

// Helper to get provider from model ID
function getProvider(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('kimi-')) return 'moonshot'
  return 'openrouter'
}

export default function AgentTeamsSettingsPage() {
  const { activeWorkspaceId, llmConnections, onWorkspaceFeatureFlagsChange } = useAppShellContext()
  const electronAPI = window.electronAPI as any

  // Implements REQ-004: keep settings navigation resilient if Agent Teams IPC/preload is unavailable.
  // This prevents a hard crash in feature-gated builds or during preload/renderer mismatches.
  const hasAgentTeamsSettingsApi =
    !!electronAPI &&
    typeof electronAPI.getAgentTeamsEnabled === 'function' &&
    typeof electronAPI.setAgentTeamsEnabled === 'function' &&
    typeof electronAPI.getWorkspaceSettings === 'function' &&
    typeof electronAPI.updateWorkspaceSetting === 'function'

  // Loading state
  const [isLoading, setIsLoading] = useState(true)

  // Teams toggle
  const [teamsEnabled, setTeamsEnabled] = useState(false)

  // Model preset
  const [selectedPreset, setSelectedPreset] = useState<ModelPresetId>('cost-optimized')

  // Per-role model assignments
  const [leadModel, setLeadModel] = useState('claude-opus-4-6')
  const [headModel, setHeadModel] = useState('claude-sonnet-4-5-20250929')
  const [workerModel, setWorkerModel] = useState('kimi-k2.5')
  const [reviewerModel, setReviewerModel] = useState('kimi-k2.5')
  const [escalationModel, setEscalationModel] = useState('claude-sonnet-4-5-20250929')

  // Per-role thinking toggles (Custom preset only)
  const [leadThinking, setLeadThinking] = useState(false)
  const [headThinking, setHeadThinking] = useState(false)
  const [workerThinking, setWorkerThinking] = useState(false)
  const [reviewerThinking, setReviewerThinking] = useState(false)
  const [escalationThinking, setEscalationThinking] = useState(false)
  // UX routing policy toggle (REQ-AUDIT-007)
  const [uxDesignPreferOpus, setUxDesignPreferOpus] = useState(true)

  // Provider API keys (stored in encrypted secure storage, not plaintext config)
  const [moonshotApiKey, setMoonshotApiKey] = useState('')
  const [moonshotKeyStored, setMoonshotKeyStored] = useState(false)
  const [openrouterApiKey, setOpenrouterApiKey] = useState('')
  const [openrouterKeyStored, setOpenrouterKeyStored] = useState(false)

  // Cost cap
  const [costCapEnabled, setCostCapEnabled] = useState(false)
  const [costCapUsd, setCostCapUsd] = useState('10')
  // Memory controls (REQ-008)
  const [memoryInjectionEnabled, setMemoryInjectionEnabled] = useState(true)
  const [knowledgeMetricsUiEnabled, setKnowledgeMetricsUiEnabled] = useState(true)

  // Quality gate settings
  const [qgEnabled, setQgEnabled] = useState(true)
  const [qgPassThreshold, setQgPassThreshold] = useState('90')
  const [qgMaxCycles, setQgMaxCycles] = useState('5')
  const [qgEnforceTDD, setQgEnforceTDD] = useState(true)
  const [qgReviewModel, setQgReviewModel] = useState('kimi-k2.5')
  const [qgTestScope, setQgTestScope] = useState<'affected' | 'full' | 'none'>('affected')
  const [qgBaselineAwareTests, setQgBaselineAwareTests] = useState(false)
  const [qgKnownFailingTests, setQgKnownFailingTests] = useState('')
  const [qgSyntaxEnabled, setQgSyntaxEnabled] = useState(true)
  const [qgTestsEnabled, setQgTestsEnabled] = useState(true)
  const [qgArchEnabled, setQgArchEnabled] = useState(true)
  const [qgSimplicityEnabled, setQgSimplicityEnabled] = useState(true)
  const [qgErrorsEnabled, setQgErrorsEnabled] = useState(true)
  const [qgCompletenessEnabled, setQgCompletenessEnabled] = useState(true)
  const [sddEnabled, setSddEnabled] = useState(false)
  const [sddRequireDriAssignment, setSddRequireDriAssignment] = useState(true)
  const [sddRequireFullCoverage, setSddRequireFullCoverage] = useState(true)
  const [sddAutoComplianceReports, setSddAutoComplianceReports] = useState(true)
  const [sddDefaultTemplate, setSddDefaultTemplate] = useState('default')
  const [sddTemplateOptions, setSddTemplateOptions] = useState<Array<{ value: string; label: string; description?: string }>>([
    { value: 'default', label: 'Default Template', description: 'Balanced spec skeleton for most features' },
  ])

  // Design Flow settings
  const [designFlowEnabled, setDesignFlowEnabled] = useState(false)
  const [designFlowVariantsPerRound, setDesignFlowVariantsPerRound] = useState<2 | 4 | 6>(4)
  const [designFlowDesignModel, setDesignFlowDesignModel] = useState<string | null>(null)
  const [designFlowAutoSaveTemplates, setDesignFlowAutoSaveTemplates] = useState(true)

  // Design template library state
  const [designTemplates, setDesignTemplates] = useState<TemplateSummary[]>([])
  const [designTemplatesLoading, setDesignTemplatesLoading] = useState(false)

  // YOLO (autonomous execution) settings
  const [yoloMode, setYoloMode] = useState<'off' | 'fixed' | 'smart'>('off')
  const [yoloCostCapUsd, setYoloCostCapUsd] = useState('5')
  const [yoloTimeoutMinutes, setYoloTimeoutMinutes] = useState('60')
  const [yoloMaxConcurrency, setYoloMaxConcurrency] = useState('3')
  const [yoloAutoRemediate, setYoloAutoRemediate] = useState(true)
  const [yoloMaxRemediationRounds, setYoloMaxRemediationRounds] = useState('3')

  const hasOpenAiConnection = (llmConnections || []).some((conn) => isOpenAIProvider(conn.providerType))

  // Load settings
  useEffect(() => {
    const loadSettings = async () => {
      if (!hasAgentTeamsSettingsApi || !activeWorkspaceId) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const enabled = await electronAPI.getAgentTeamsEnabled(activeWorkspaceId)
        setTeamsEnabled(enabled)

        // Load workspace settings for model config
        const settings = await electronAPI.getWorkspaceSettings(activeWorkspaceId)
        if (settings?.agentTeamsModelPreset) {
          const migrated = migratePresetId(settings.agentTeamsModelPreset)
          setSelectedPreset(migrated)
          // Persist migration if changed
          if (migrated !== settings.agentTeamsModelPreset) {
            await electronAPI.updateWorkspaceSetting(activeWorkspaceId, 'agentTeamsModelPreset', migrated)
          }
        }
        if (settings?.agentTeamsLeadModel) setLeadModel(settings.agentTeamsLeadModel)
        if (settings?.agentTeamsHeadModel) setHeadModel(settings.agentTeamsHeadModel)
        if (settings?.agentTeamsWorkerModel) setWorkerModel(settings.agentTeamsWorkerModel)
        if (settings?.agentTeamsReviewerModel) {
          setReviewerModel(settings.agentTeamsReviewerModel)
          setQgReviewModel(settings.agentTeamsReviewerModel)
        }
        if (settings?.agentTeamsEscalationModel) setEscalationModel(settings.agentTeamsEscalationModel)
        // Load thinking toggles
        if (settings?.agentTeamsLeadThinking !== undefined) setLeadThinking(settings.agentTeamsLeadThinking)
        if (settings?.agentTeamsHeadThinking !== undefined) setHeadThinking(settings.agentTeamsHeadThinking)
        if (settings?.agentTeamsWorkerThinking !== undefined) setWorkerThinking(settings.agentTeamsWorkerThinking)
        if (settings?.agentTeamsReviewerThinking !== undefined) setReviewerThinking(settings.agentTeamsReviewerThinking)
        if (settings?.agentTeamsEscalationThinking !== undefined) setEscalationThinking(settings.agentTeamsEscalationThinking)
        if (settings?.agentTeamsUxDesignPreferOpus !== undefined) setUxDesignPreferOpus(settings.agentTeamsUxDesignPreferOpus)
        if (settings?.agentTeamsCostCapUsd) {
          setCostCapEnabled(true)
          setCostCapUsd(String(settings.agentTeamsCostCapUsd))
        }
        if (settings?.agentTeamsMemoryInjectionEnabled !== undefined) setMemoryInjectionEnabled(settings.agentTeamsMemoryInjectionEnabled)
        if (settings?.agentTeamsKnowledgeMetricsUiEnabled !== undefined) setKnowledgeMetricsUiEnabled(settings.agentTeamsKnowledgeMetricsUiEnabled)

        // Load quality gate settings
        if (settings?.qualityGatesEnabled !== undefined) setQgEnabled(settings.qualityGatesEnabled)
        if (settings?.qualityGatesPassThreshold) setQgPassThreshold(String(settings.qualityGatesPassThreshold))
        if (settings?.qualityGatesMaxCycles) setQgMaxCycles(String(settings.qualityGatesMaxCycles))
        if (settings?.qualityGatesEnforceTDD !== undefined) setQgEnforceTDD(settings.qualityGatesEnforceTDD)
        if (settings?.qualityGatesReviewModel) {
          setQgReviewModel(settings.qualityGatesReviewModel)
          if (!settings?.agentTeamsReviewerModel) {
            setReviewerModel(settings.qualityGatesReviewModel)
          }
        }
        if (settings?.qualityGatesTestScope) setQgTestScope(settings.qualityGatesTestScope as 'affected' | 'full' | 'none')
        if (settings?.qualityGatesBaselineAwareTests !== undefined) setQgBaselineAwareTests(settings.qualityGatesBaselineAwareTests)
        setQgKnownFailingTests(stringifyKnownFailingTests(settings?.qualityGatesKnownFailingTests))
        if (settings?.qualityGatesSyntaxEnabled !== undefined) setQgSyntaxEnabled(settings.qualityGatesSyntaxEnabled)
        if (settings?.qualityGatesTestsEnabled !== undefined) setQgTestsEnabled(settings.qualityGatesTestsEnabled)
        if (settings?.qualityGatesArchEnabled !== undefined) setQgArchEnabled(settings.qualityGatesArchEnabled)
        if (settings?.qualityGatesSimplicityEnabled !== undefined) setQgSimplicityEnabled(settings.qualityGatesSimplicityEnabled)
        if (settings?.qualityGatesErrorsEnabled !== undefined) setQgErrorsEnabled(settings.qualityGatesErrorsEnabled)
        if (settings?.qualityGatesCompletenessEnabled !== undefined) setQgCompletenessEnabled(settings.qualityGatesCompletenessEnabled)
        // Load YOLO settings
        if (settings?.yoloMode) setYoloMode(settings.yoloMode as 'off' | 'fixed' | 'smart')
        if (settings?.yoloCostCapUsd) setYoloCostCapUsd(String(settings.yoloCostCapUsd))
        if (settings?.yoloTimeoutMinutes) setYoloTimeoutMinutes(String(settings.yoloTimeoutMinutes))
        if (settings?.yoloMaxConcurrency) setYoloMaxConcurrency(String(settings.yoloMaxConcurrency))
        if (settings?.yoloAutoRemediate !== undefined) setYoloAutoRemediate(settings.yoloAutoRemediate)
        if (settings?.yoloMaxRemediationRounds) setYoloMaxRemediationRounds(String(settings.yoloMaxRemediationRounds))

        if (settings?.sddEnabled !== undefined) setSddEnabled(settings.sddEnabled)
        if (settings?.sddRequireDRIAssignment !== undefined) setSddRequireDriAssignment(settings.sddRequireDRIAssignment)
        if (settings?.sddRequireFullCoverage !== undefined) setSddRequireFullCoverage(settings.sddRequireFullCoverage)
        if (settings?.sddAutoComplianceReports !== undefined) setSddAutoComplianceReports(settings.sddAutoComplianceReports)
        if (settings?.sddDefaultSpecTemplate) setSddDefaultTemplate(settings.sddDefaultSpecTemplate)
        if (settings?.sddSpecTemplates && settings.sddSpecTemplates.length > 0) {
          setSddTemplateOptions(settings.sddSpecTemplates.map((template: { id: string; name: string; description?: string }) => ({
            value: template.id,
            label: template.name,
            description: template.description,
          })))
        }

        // Load design flow settings
        if (settings?.designFlowEnabled !== undefined) setDesignFlowEnabled(settings.designFlowEnabled)
        if (settings?.designFlowVariantsPerRound) setDesignFlowVariantsPerRound(settings.designFlowVariantsPerRound)
        if (settings?.designFlowDesignModel !== undefined) setDesignFlowDesignModel(settings.designFlowDesignModel)
        if (settings?.designFlowAutoSaveTemplates !== undefined) setDesignFlowAutoSaveTemplates(settings.designFlowAutoSaveTemplates)

        // Load design templates if design flow is enabled
        if (settings?.designFlowEnabled) {
          try {
            setDesignTemplatesLoading(true)
            const templates = typeof electronAPI.listDesignTemplates === 'function'
              ? await electronAPI.listDesignTemplates(activeWorkspaceId)
              : []
            setDesignTemplates(templates.map((t: { id: string; name: string; direction: string; framework: string | null; typescript: boolean; fileCount: number; createdAt: string; compatible: boolean }) => ({
              ...t,
              description: t.direction,
              compatible: t.compatible,
            })))
          } catch {
            // Templates are optional — don't block settings load
          } finally {
            setDesignTemplatesLoading(false)
          }
        }

        // Load provider API key status from secure storage
        const canReadProviderKeys = typeof electronAPI.getAgentTeamsProviderKey === 'function'
        const [moonshotStatus, openrouterStatus] = await Promise.all([
          canReadProviderKeys ? electronAPI.getAgentTeamsProviderKey('moonshot') : Promise.resolve(null),
          canReadProviderKeys ? electronAPI.getAgentTeamsProviderKey('openrouter') : Promise.resolve(null),
        ])
        if (moonshotStatus?.hasKey) {
          setMoonshotKeyStored(true)
          setMoonshotApiKey(moonshotStatus.maskedKey || '')
        }
        if (openrouterStatus?.hasKey) {
          setOpenrouterKeyStored(true)
          setOpenrouterApiKey(openrouterStatus.maskedKey || '')
        }
      } catch (error) {
        console.error('Failed to load agent teams settings:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadSettings()
  }, [activeWorkspaceId, hasAgentTeamsSettingsApi, electronAPI])

  // Save workspace setting helper
  const saveSetting = useCallback(
    async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
      if (!hasAgentTeamsSettingsApi || !activeWorkspaceId) return
      try {
        await electronAPI.updateWorkspaceSetting(activeWorkspaceId, key, value)
      } catch (error) {
        console.error(`Failed to save ${key}:`, error)
      }
    },
    [activeWorkspaceId, hasAgentTeamsSettingsApi, electronAPI]
  )

  // Toggle handler
  const handleTeamsToggle = useCallback(
    async (enabled: boolean) => {
      setTeamsEnabled(enabled)
      // Update App.tsx state so Session Controls dropdown reflects the change immediately
      onWorkspaceFeatureFlagsChange?.({ agentTeamsEnabled: enabled })
      if (!hasAgentTeamsSettingsApi || !activeWorkspaceId) return
      try {
        await electronAPI.setAgentTeamsEnabled(activeWorkspaceId, enabled)
      } catch (error) {
        console.error('Failed to toggle agent teams:', error)
      }
    },
    [activeWorkspaceId, hasAgentTeamsSettingsApi, onWorkspaceFeatureFlagsChange, electronAPI]
  )

  // Preset change handler
  const handlePresetChange = useCallback(
    (presetId: string) => {
      const id = presetId as ModelPresetId
      setSelectedPreset(id)
      saveSetting('agentTeamsModelPreset', id)

      if (id !== 'custom') {
        const config = STRATEGY_CONFIGS[id] ?? STRATEGY_CONFIGS['smart']
        setLeadModel(config.lead)
        setHeadModel(config.head)
        setWorkerModel(config.worker)
        setReviewerModel(config.reviewer)
        setEscalationModel(config.escalation)
        saveSetting('agentTeamsLeadModel', config.lead)
        saveSetting('agentTeamsHeadModel', config.head)
        saveSetting('agentTeamsWorkerModel', config.worker)
        saveSetting('agentTeamsReviewerModel', config.reviewer)
        saveSetting('agentTeamsEscalationModel', config.escalation)
        setQgReviewModel(config.reviewer)
        saveSetting('qualityGatesReviewModel', config.reviewer)

        // Implements REQ-P3: Auto thinking per strategy
        const thinking = STRATEGY_THINKING[id]
        if (thinking) {
          setLeadThinking(thinking.lead ?? false)
          setHeadThinking(thinking.head ?? false)
          setWorkerThinking(thinking.worker ?? false)
          setReviewerThinking(thinking.reviewer ?? false)
          setEscalationThinking(thinking.escalation ?? false)
          saveSetting('agentTeamsLeadThinking', thinking.lead ?? false)
          saveSetting('agentTeamsHeadThinking', thinking.head ?? false)
          saveSetting('agentTeamsWorkerThinking', thinking.worker ?? false)
          saveSetting('agentTeamsReviewerThinking', thinking.reviewer ?? false)
          saveSetting('agentTeamsEscalationThinking', thinking.escalation ?? false)
        }
      }
    },
    [saveSetting]
  )

  // Role model change handlers
  const handleLeadChange = useCallback((v: string) => {
    setLeadModel(v)
    setSelectedPreset('custom')
    saveSetting('agentTeamsModelPreset', 'custom')
    saveSetting('agentTeamsLeadModel', v)
  }, [saveSetting])

  const handleHeadChange = useCallback((v: string) => {
    setHeadModel(v)
    setSelectedPreset('custom')
    saveSetting('agentTeamsModelPreset', 'custom')
    saveSetting('agentTeamsHeadModel', v)
  }, [saveSetting])

  const handleWorkerChange = useCallback((v: string) => {
    setWorkerModel(v)
    setSelectedPreset('custom')
    saveSetting('agentTeamsModelPreset', 'custom')
    saveSetting('agentTeamsWorkerModel', v)
  }, [saveSetting])

  const handleReviewerChange = useCallback((v: string) => {
    setReviewerModel(v)
    setQgReviewModel(v)
    setSelectedPreset('custom')
    saveSetting('agentTeamsModelPreset', 'custom')
    saveSetting('agentTeamsReviewerModel', v)
    saveSetting('qualityGatesReviewModel', v)
  }, [saveSetting])

  const handleEscalationChange = useCallback((v: string) => {
    setEscalationModel(v)
    setSelectedPreset('custom')
    saveSetting('agentTeamsModelPreset', 'custom')
    saveSetting('agentTeamsEscalationModel', v)
  }, [saveSetting])

  // Thinking toggle handlers (Custom preset only)
  const handleThinkingToggle = useCallback((role: string, enabled: boolean) => {
    const setters: Record<string, (v: boolean) => void> = {
      lead: setLeadThinking, head: setHeadThinking, worker: setWorkerThinking,
      reviewer: setReviewerThinking, escalation: setEscalationThinking,
    }
    const keys: Record<string, keyof WorkspaceSettings> = {
      lead: 'agentTeamsLeadThinking', head: 'agentTeamsHeadThinking', worker: 'agentTeamsWorkerThinking',
      reviewer: 'agentTeamsReviewerThinking', escalation: 'agentTeamsEscalationThinking',
    }
    setters[role]?.(enabled)
    if (keys[role]) saveSetting(keys[role], enabled)
  }, [saveSetting])

  // Implements REQ-AUDIT-007: allow users to control UX/Design Opus preference policy.
  const handleUxDesignPreferOpusToggle = useCallback((enabled: boolean) => {
    setUxDesignPreferOpus(enabled)
    saveSetting('agentTeamsUxDesignPreferOpus', enabled)
  }, [saveSetting])

  // Cost cap handlers
  const handleCostCapToggle = useCallback((enabled: boolean) => {
    setCostCapEnabled(enabled)
    if (!enabled) {
      saveSetting('agentTeamsCostCapUsd', undefined)
    } else {
      saveSetting('agentTeamsCostCapUsd', parseFloat(costCapUsd) || 10)
    }
  }, [costCapUsd, saveSetting])

  const handleCostCapChange = useCallback((value: string) => {
    setCostCapUsd(value)
  }, [])

  const handleCostCapBlur = useCallback(() => {
    const parsed = parseFloat(costCapUsd)
    if (!isNaN(parsed) && parsed > 0) {
      saveSetting('agentTeamsCostCapUsd', parsed)
    }
  }, [costCapUsd, saveSetting])

  // Provider API key save handlers (secure encrypted storage)
  const handleMoonshotKeyFocus = useCallback(() => {
    // Clear masked placeholder when user focuses to enter a new key
    if (moonshotKeyStored) {
      setMoonshotApiKey('')
    }
  }, [moonshotKeyStored])

  const handleMoonshotKeyBlur = useCallback(async () => {
    if (!electronAPI || typeof electronAPI.setAgentTeamsProviderKey !== 'function') return
    if (!moonshotApiKey || moonshotApiKey.includes('*')) return
    try {
      await electronAPI.setAgentTeamsProviderKey('moonshot', moonshotApiKey)
      setMoonshotKeyStored(true)
      // Replace with masked version for display
      const status = typeof electronAPI.getAgentTeamsProviderKey === 'function'
        ? await electronAPI.getAgentTeamsProviderKey('moonshot')
        : null
      if (status?.maskedKey) setMoonshotApiKey(status.maskedKey)
    } catch (error) {
      console.error('Failed to save Moonshot API key:', error)
    }
  }, [electronAPI, moonshotApiKey])

  const handleOpenrouterKeyFocus = useCallback(() => {
    if (openrouterKeyStored) {
      setOpenrouterApiKey('')
    }
  }, [openrouterKeyStored])

  const handleOpenrouterKeyBlur = useCallback(async () => {
    if (!electronAPI || typeof electronAPI.setAgentTeamsProviderKey !== 'function') return
    if (!openrouterApiKey || openrouterApiKey.includes('*')) return
    try {
      await electronAPI.setAgentTeamsProviderKey('openrouter', openrouterApiKey)
      setOpenrouterKeyStored(true)
      const status = typeof electronAPI.getAgentTeamsProviderKey === 'function'
        ? await electronAPI.getAgentTeamsProviderKey('openrouter')
        : null
      if (status?.maskedKey) setOpenrouterApiKey(status.maskedKey)
    } catch (error) {
      console.error('Failed to save OpenRouter API key:', error)
    }
  }, [electronAPI, openrouterApiKey])

  const handleMemoryInjectionToggle = useCallback((enabled: boolean) => {
    setMemoryInjectionEnabled(enabled)
    saveSetting('agentTeamsMemoryInjectionEnabled', enabled)
  }, [saveSetting])

  const handleKnowledgeMetricsUiToggle = useCallback((enabled: boolean) => {
    setKnowledgeMetricsUiEnabled(enabled)
    saveSetting('agentTeamsKnowledgeMetricsUiEnabled', enabled)
  }, [saveSetting])

  // Quality gate handlers
  const handleQgToggle = useCallback((enabled: boolean) => {
    setQgEnabled(enabled)
    saveSetting('qualityGatesEnabled', enabled)
  }, [saveSetting])

  const handleQgThresholdBlur = useCallback(() => {
    const val = Math.max(0, Math.min(100, parseInt(qgPassThreshold) || 90))
    setQgPassThreshold(String(val))
    saveSetting('qualityGatesPassThreshold', val)
  }, [qgPassThreshold, saveSetting])

  const handleQgMaxCyclesBlur = useCallback(() => {
    const val = Math.max(1, Math.min(10, parseInt(qgMaxCycles) || 5))
    setQgMaxCycles(String(val))
    saveSetting('qualityGatesMaxCycles', val)
  }, [qgMaxCycles, saveSetting])

  const handleQgTDDToggle = useCallback((enabled: boolean) => {
    setQgEnforceTDD(enabled)
    saveSetting('qualityGatesEnforceTDD', enabled)
  }, [saveSetting])

  const handleQgReviewModelChange = useCallback((v: string) => {
    setQgReviewModel(v)
    setReviewerModel(v)
    saveSetting('qualityGatesReviewModel', v)
    saveSetting('agentTeamsReviewerModel', v)
  }, [saveSetting])

  const handleQgTestScopeChange = useCallback((v: string) => {
    const scope = v as 'affected' | 'full' | 'none'
    setQgTestScope(scope)
    saveSetting('qualityGatesTestScope', scope)
  }, [saveSetting])

  const handleQgBaselineAwareTestsToggle = useCallback((enabled: boolean) => {
    setQgBaselineAwareTests(enabled)
    saveSetting('qualityGatesBaselineAwareTests', enabled)
  }, [saveSetting])

  const handleQgKnownFailingTestsChange = useCallback((value: string) => {
    setQgKnownFailingTests(value)
    saveSetting('qualityGatesKnownFailingTests', parseKnownFailingTests(value))
  }, [saveSetting])

  const handleQgStageToggle = useCallback((stage: string, enabled: boolean) => {
    switch (stage) {
      case 'syntax': setQgSyntaxEnabled(enabled); saveSetting('qualityGatesSyntaxEnabled', enabled); break
      case 'tests': setQgTestsEnabled(enabled); saveSetting('qualityGatesTestsEnabled', enabled); break
      case 'architecture': setQgArchEnabled(enabled); saveSetting('qualityGatesArchEnabled', enabled); break
      case 'simplicity': setQgSimplicityEnabled(enabled); saveSetting('qualityGatesSimplicityEnabled', enabled); break
      case 'errors': setQgErrorsEnabled(enabled); saveSetting('qualityGatesErrorsEnabled', enabled); break
      case 'completeness': setQgCompletenessEnabled(enabled); saveSetting('qualityGatesCompletenessEnabled', enabled); break
    }
  }, [saveSetting])

  const handleSddEnabledToggle = useCallback((enabled: boolean) => {
    setSddEnabled(enabled)
    saveSetting('sddEnabled', enabled)

    if (enabled && !sddRequireDriAssignment) {
      setSddRequireDriAssignment(true)
      saveSetting('sddRequireDRIAssignment', true)
    }
  }, [saveSetting, sddRequireDriAssignment])

  const handleSddRequireDriToggle = useCallback((enabled: boolean) => {
    setSddRequireDriAssignment(enabled)
    saveSetting('sddRequireDRIAssignment', enabled)
  }, [saveSetting])

  const handleSddRequireCoverageToggle = useCallback((enabled: boolean) => {
    setSddRequireFullCoverage(enabled)
    saveSetting('sddRequireFullCoverage', enabled)
  }, [saveSetting])

  const handleSddAutoComplianceToggle = useCallback((enabled: boolean) => {
    setSddAutoComplianceReports(enabled)
    saveSetting('sddAutoComplianceReports', enabled)
  }, [saveSetting])

  const handleSddTemplateChange = useCallback((templateId: string) => {
    setSddDefaultTemplate(templateId)
    saveSetting('sddDefaultSpecTemplate', templateId)
  }, [saveSetting])

  // Design template handlers
  // NOTE: Must be defined BEFORE Design Flow handlers to avoid TDZ runtime errors
  // ("Cannot access 'loadDesignTemplates' before initialization").
  const loadDesignTemplates = useCallback(async () => {
    if (!electronAPI || typeof electronAPI.listDesignTemplates !== 'function' || !activeWorkspaceId) return
    setDesignTemplatesLoading(true)
    try {
      const templates = await electronAPI.listDesignTemplates(activeWorkspaceId)
      setDesignTemplates(templates.map((t: { id: string; name: string; direction: string; framework: string | null; typescript: boolean; fileCount: number; createdAt: string; compatible: boolean }) => ({
        ...t,
        description: t.direction,
        compatible: t.compatible,
      })))
    } catch {
      setDesignTemplates([])
    } finally {
      setDesignTemplatesLoading(false)
    }
  }, [activeWorkspaceId, electronAPI])

  const handleLoadTemplateDetail = useCallback(async (templateId: string): Promise<TemplateDetail | null> => {
    if (!electronAPI || typeof electronAPI.loadDesignTemplate !== 'function' || !activeWorkspaceId) return null
    const full = await electronAPI.loadDesignTemplate(activeWorkspaceId, templateId)
    if (!full) return null
    return {
      id: full.id,
      name: full.name,
      description: full.description ?? '',
      direction: full.direction,
      brief: full.brief,
      componentSpec: full.componentSpec,
      files: full.files,
      stackRequirements: full.stackRequirements,
      createdAt: full.createdAt,
      sourceSessionId: full.sourceSessionId,
      sourceTeamId: full.sourceTeamId,
    }
  }, [activeWorkspaceId, electronAPI])

  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    if (!electronAPI || typeof electronAPI.deleteDesignTemplate !== 'function' || !activeWorkspaceId) return
    await electronAPI.deleteDesignTemplate(activeWorkspaceId, templateId)
    setDesignTemplates(prev => prev.filter(t => t.id !== templateId))
  }, [activeWorkspaceId, electronAPI])

  // Design Flow handlers
  const handleDesignFlowToggle = useCallback((enabled: boolean) => {
    setDesignFlowEnabled(enabled)
    saveSetting('designFlowEnabled', enabled)
    // Update App.tsx state so Session Controls dropdown reflects the change immediately
    onWorkspaceFeatureFlagsChange?.({ designFlowEnabled: enabled })
    if (enabled) loadDesignTemplates()
  }, [saveSetting, loadDesignTemplates, onWorkspaceFeatureFlagsChange])

  const handleDesignFlowVariantsChange = useCallback((value: string) => {
    const count = parseInt(value) as 2 | 4 | 6
    setDesignFlowVariantsPerRound(count)
    saveSetting('designFlowVariantsPerRound', count)
  }, [saveSetting])

  const handleDesignFlowModelChange = useCallback((value: string) => {
    const model = value === 'inherit' ? null : value
    setDesignFlowDesignModel(model)
    saveSetting('designFlowDesignModel', model)
  }, [saveSetting])

  const handleDesignFlowAutoSaveToggle = useCallback((enabled: boolean) => {
    setDesignFlowAutoSaveTemplates(enabled)
    saveSetting('designFlowAutoSaveTemplates', enabled)
  }, [saveSetting])

  // YOLO handlers
  const handleYoloModeChange = useCallback((mode: string) => {
    const m = mode as 'off' | 'fixed' | 'smart'
    setYoloMode(m)
    saveSetting('yoloMode', m)
    // Update App.tsx state so Session Controls dropdown reflects the change immediately
    onWorkspaceFeatureFlagsChange?.({ yoloEnabled: m !== 'off' })
  }, [saveSetting, onWorkspaceFeatureFlagsChange])

  const handleYoloCostCapBlur = useCallback(() => {
    const parsed = parseFloat(yoloCostCapUsd)
    if (!isNaN(parsed) && parsed > 0) {
      saveSetting('yoloCostCapUsd', parsed)
    }
  }, [yoloCostCapUsd, saveSetting])

  const handleYoloTimeoutBlur = useCallback(() => {
    const val = Math.max(1, Math.min(1440, parseInt(yoloTimeoutMinutes) || 60))
    setYoloTimeoutMinutes(String(val))
    saveSetting('yoloTimeoutMinutes', val)
  }, [yoloTimeoutMinutes, saveSetting])

  const handleYoloMaxConcurrencyBlur = useCallback(() => {
    const val = Math.max(1, Math.min(10, parseInt(yoloMaxConcurrency) || 3))
    setYoloMaxConcurrency(String(val))
    saveSetting('yoloMaxConcurrency', val)
  }, [yoloMaxConcurrency, saveSetting])

  const handleYoloAutoRemediateToggle = useCallback((enabled: boolean) => {
    setYoloAutoRemediate(enabled)
    saveSetting('yoloAutoRemediate', enabled)
  }, [saveSetting])

  const handleYoloMaxRemediationRoundsBlur = useCallback(() => {
    const val = Math.max(0, Math.min(10, parseInt(yoloMaxRemediationRounds) || 3))
    setYoloMaxRemediationRounds(String(val))
    saveSetting('yoloMaxRemediationRounds', val)
  }, [yoloMaxRemediationRounds, saveSetting])

  const hasCodexConnection = llmConnections.some((conn) =>
    isOpenAIProvider(conn.providerType) && conn.isAuthenticated
  )

  const codexSelected = [leadModel, headModel, workerModel, reviewerModel, escalationModel, qgReviewModel].some((model) =>
    isCodexModel(model)
  )

  // Implements REQ-AT-011: Surface newly configured Codex models in Agent Teams settings.
  const codexModelOptions = React.useMemo(() => {
    const optionsById = new Map<string, { value: string; label: string; description?: string }>()

    for (const option of CODEX_MODEL_OPTIONS) {
      optionsById.set(option.value, option)
    }

    for (const connection of llmConnections || []) {
      if (!isOpenAIProvider(connection.providerType)) continue
      if (!Array.isArray(connection.models)) continue

      for (const model of connection.models) {
        const modelId = typeof model === 'string' ? model : model?.id
        if (!modelId || !isCodexModel(modelId) || optionsById.has(modelId)) continue

        const modelName = typeof model === 'string'
          ? getModelShortName(modelId)
          : (model.name || getModelShortName(modelId))

        optionsById.set(modelId, {
          value: modelId,
          label: modelName,
          description: `Available via ${connection.name}`,
        })
      }
    }

    return Array.from(optionsById.values())
  }, [llmConnections])

  const roleModelOptions = React.useMemo(() => {
    if (hasCodexConnection || codexSelected) {
      return [
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('claude-')),
        ...codexModelOptions,
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('kimi-')),
      ]
    }
    return BASE_MODEL_OPTIONS
  }, [hasCodexConnection, codexSelected, codexModelOptions])

  const reviewModelOptions = React.useMemo(() => {
    if (hasCodexConnection || codexSelected) {
      return [
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('claude-')),
        ...codexModelOptions,
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('kimi-')),
      ]
    }
    return BASE_MODEL_OPTIONS
  }, [hasCodexConnection, codexSelected, codexModelOptions])

  const renderQualityHelpLabel = useCallback((entryKey: keyof typeof QUALITY_GATE_HELP, fallback: string) => {
    const help = QUALITY_GATE_HELP[entryKey]
    if (!help) return fallback

    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{help.title}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex text-muted-foreground hover:text-foreground cursor-help align-middle" aria-label={`${help.title} details`}>
              <Info className="size-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm">
            <div className="space-y-1 text-xs leading-relaxed">
              <p><span className="font-semibold">Checks:</span> {help.meaning}</p>
              <p><span className="font-semibold">Why enable:</span> {help.whyEnable}</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </span>
    )
  }, [])

  // Check which non-Claude providers are needed
  const needsMoonshot = [leadModel, headModel, workerModel, reviewerModel].some(m => m.startsWith('kimi-'))
  const needsOpenRouter = [leadModel, headModel, workerModel, reviewerModel, escalationModel].some(m =>
    !m.startsWith('claude-') && !m.startsWith('kimi-') && !isCodexModel(m)
  )

  // Empty state
  if (!activeWorkspaceId) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title="Agent Teams" actions={<HeaderMenu route={routes.view.settings('agent-teams')} />} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">No workspace selected</p>
        </div>
      </div>
    )
  }

  if (!hasAgentTeamsSettingsApi) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title="Agent Teams" actions={<HeaderMenu route={routes.view.settings('agent-teams')} />} />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-xl text-center">
            <p className="text-sm font-medium">Agent Teams settings are unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Agent Teams may be disabled in this build, or the preload bridge may be out of sync.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title="Agent Teams" actions={<HeaderMenu route={routes.view.settings('agent-teams')} />} />
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="Agent Teams" actions={<HeaderMenu route={routes.view.settings('agent-teams')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">

              {/* Master Toggle */}
              <SettingsSection
                title="Agent Teams"
                description="Enable multi-agent orchestration with shared task lists and team coordination"
              >
                <SettingsCard>
                  <SettingsToggle
                    label="Enable Agent Teams"
                    description="Allows creating teams of AI agents that collaborate on tasks"
                    checked={teamsEnabled}
                    onCheckedChange={handleTeamsToggle}
                  />
                  {!hasOpenAiConnection && (
                    <div className="text-xs text-amber-600 mt-2">
                      Codex lead requires an OpenAI connection. Add one in API setup to use Codex as the lead model.
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Everything below is conditional on teams being enabled */}
              <AnimatePresence>
                {teamsEnabled && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                    className="space-y-8 overflow-hidden"
                  >

                    {/* Model Strategy */}
                    <SettingsSection
                      title="Model Strategy"
                      description="Choose a strategy for your teams — thinking and models are auto-configured per role"
                      className="relative"
                    >
                      <SettingsRadioGroup
                        value={selectedPreset}
                        onValueChange={handlePresetChange}
                      >
                        {STRATEGY_OPTIONS.map((preset) => (
                          <SettingsRadioCard
                            key={preset.id}
                            value={preset.id}
                            label={preset.name}
                            description={preset.description}
                            badge={preset.badge ? (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                                {preset.badge}
                              </span>
                            ) : preset.costLevel > 0 ? (
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${COST_BADGE_COLORS[preset.costLevel as CostLevel]}`}>
                                {preset.cost}
                              </span>
                            ) : undefined}
                            expandedContent={preset.id !== 'custom' ? (
                              /* Role → model summary grid for non-custom strategies */
                              <div className="grid grid-cols-5 gap-2 pt-1">
                                {(['lead', 'head', 'worker', 'reviewer', 'escalation'] as const).map((role) => (
                                  <div key={role} className="flex flex-col items-center gap-1">
                                    <div className={`w-2 h-2 rounded-full ${ROLE_COLORS[role]}`} />
                                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{role}</span>
                                    <span className="text-xs font-medium">{getModelShortName(STRATEGY_CONFIGS[preset.id][role])}</span>
                                  </div>
                                ))}
                              </div>
                            ) : undefined}
                          />
                        ))}
                      </SettingsRadioGroup>

                      {selectedPreset === 'smart' && (
                        <p className="text-xs text-muted-foreground mt-2">
                          Workers use Sonnet when Quality Gates are on (fast, errors caught by QG).
                          Workers use Opus when Quality Gates are off (no safety net).
                          Thinking enabled for Lead, Reviewer, and Escalation roles.
                        </p>
                      )}

                      <SettingsCard className="mt-4">
                        <SettingsToggle
                          label="Prefer Opus for UX/Design"
                          description="When enabled, UX/Design tasks try Opus first, then fall back to Codex Spark/Codex if Opus is unavailable. UX/Design always keeps Thinking ON."
                          checked={uxDesignPreferOpus}
                          onCheckedChange={handleUxDesignPreferOpusToggle}
                        />
                      </SettingsCard>
                    </SettingsSection>

                    {/* Per-Role Model Assignment (Custom strategy only) */}
                    {selectedPreset === 'custom' && (
                      <SettingsSection title="Per-Role Model Assignment">
                        <SettingsCard>
                          <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-foreground/[0.02] border border-border/40 mx-4 mt-3">
                            <Info className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
                            <p className="text-[11px] text-muted-foreground leading-relaxed">
                              Lead: Opus/Codex (planning) · Worker: Haiku/Kimi (throughput) · Reviewer: Haiku/Kimi (fast checks) · Escalation: Opus/Codex (hard blockers)
                            </p>
                          </div>
                          <div className="space-y-4 px-4 py-3">
                            {([
                              { role: 'lead', label: 'Lead', desc: 'Plans work and delegates', model: leadModel, onChange: handleLeadChange, thinking: leadThinking },
                              { role: 'worker', label: 'Worker', desc: 'Executes individual tasks', model: workerModel, onChange: handleWorkerChange, thinking: workerThinking },
                              { role: 'reviewer', label: 'Reviewer', desc: 'Quality gate reviews', model: reviewerModel, onChange: handleReviewerChange, thinking: reviewerThinking },
                              { role: 'escalation', label: 'Escalation', desc: 'Handles failures', model: escalationModel, onChange: handleEscalationChange, thinking: escalationThinking },
                            ] as const).map(({ role, label, desc, model, onChange, thinking }) => (
                              <div key={role} className="flex items-center gap-3 py-1">
                                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${ROLE_COLORS[role]}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium">{label}</span>
                                    <span className="text-[10px] text-muted-foreground">{desc}</span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-1.5">
                                    <select
                                      value={model}
                                      onChange={(e) => onChange(e.target.value)}
                                      className="h-7 text-xs rounded-md border border-border/60 bg-background px-2 pr-6 appearance-none cursor-pointer hover:border-border focus:outline-none focus:ring-1 focus:ring-ring"
                                    >
                                      {roleModelOptions.map((opt) => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                    <button
                                      type="button"
                                      onClick={() => handleThinkingToggle(role, !thinking)}
                                      className={`h-7 px-2.5 text-[10px] font-medium rounded-md border transition-colors ${
                                        thinking
                                          ? 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400'
                                          : 'border-border/60 bg-background text-muted-foreground hover:text-foreground'
                                      }`}
                                    >
                                      {thinking ? 'Thinking ON' : 'Thinking OFF'}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </SettingsCard>
                      </SettingsSection>
                    )}

                    {(codexSelected && !hasCodexConnection) && (
                      <SettingsSection
                        title="Codex Connection Required"
                        description="One or more roles use Codex models. Connect an OpenAI/Codex account to run those teammates."
                      >
                        <SettingsCard>
                          <SettingsRow
                            label="OpenAI/Codex not connected"
                            description="Set up a Codex connection in AI settings to enable Codex models for teams."
                            action={(
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => navigate(routes.view.settings('ai'))}
                              >
                                Open AI Settings
                              </Button>
                            )}
                          />
                        </SettingsCard>
                      </SettingsSection>
                    )}

                    {/* Provider API Keys (only shown when non-Claude models selected) */}
                    {(needsMoonshot || needsOpenRouter) && (
                      <SettingsSection
                        title="Provider API Keys"
                        description="Required for non-Claude models"
                      >
                        <SettingsCard>
                          {needsMoonshot && (
                            <div className="px-4 py-3.5">
                              <SettingsInput
                                label="Moonshot API Key"
                                description={moonshotKeyStored ? 'Saved securely — click to replace' : 'For Kimi K2.5 models'}
                                value={moonshotApiKey}
                                onChange={setMoonshotApiKey}
                                type="password"
                                placeholder="sk-..."
                                onFocus={handleMoonshotKeyFocus}
                                onBlur={handleMoonshotKeyBlur}
                              />
                            </div>
                          )}
                          {needsOpenRouter && (
                            <div className="px-4 py-3.5">
                              <SettingsInput
                                label="OpenRouter API Key"
                                description={openrouterKeyStored ? 'Saved securely — click to replace' : 'For Gemini, DeepSeek, Llama models'}
                                value={openrouterApiKey}
                                onChange={setOpenrouterApiKey}
                                type="password"
                                placeholder="sk-or-..."
                                onFocus={handleOpenrouterKeyFocus}
                                onBlur={handleOpenrouterKeyBlur}
                              />
                            </div>
                          )}
                        </SettingsCard>
                      </SettingsSection>
                    )}

                    {/* Cost Management */}
                    <SettingsSection
                      title="Cost Management"
                      description="Control spending limits for agent teams"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Cost cap"
                          description="Pause team activity when cost limit is reached"
                          checked={costCapEnabled}
                          onCheckedChange={handleCostCapToggle}
                        />
                        {costCapEnabled && (
                          <div className="px-4 pb-3.5">
                            <SettingsInput
                              label="Maximum cost per session (USD)"
                              value={costCapUsd}
                              onChange={handleCostCapChange}
                              onBlur={handleCostCapBlur}
                              placeholder="10"
                            />
                          </div>
                        )}
                      </SettingsCard>
                    </SettingsSection>

                    <SettingsSection
                      title="Memory Controls"
                      description="Operational kill-switches for shared memory injection and dashboard metrics"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Enable memory injection"
                          description="Inject relevant Team Knowledge Bus context into spawned teammate prompts"
                          checked={memoryInjectionEnabled}
                          onCheckedChange={handleMemoryInjectionToggle}
                        />
                        <SettingsToggle
                          label="Show Knowledge metrics UI"
                          description="Expose Team Dashboard Knowledge tab and operational memory health metrics"
                          checked={knowledgeMetricsUiEnabled}
                          onCheckedChange={handleKnowledgeMetricsUiToggle}
                        />
                      </SettingsCard>
                    </SettingsSection>

                    {/* Quality Gates */}
                    <SettingsSection
                      title="Quality Gates"
                      description="Automated code review pipeline — teammate work is reviewed, scored, and sent back for rework if below threshold"
                      className="border-l-2 border-l-amber-500/50 pl-4"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Enable Quality Gates"
                          description="Automatically review completed tasks and send feedback to teammates for rework if needed"
                          checked={qgEnabled}
                          onCheckedChange={handleQgToggle}
                        />
                      </SettingsCard>

                      <AnimatePresence>
                        {qgEnabled && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                            className="space-y-4 overflow-hidden"
                          >
                            {/* Thresholds */}
                            <SettingsCard>
                              <div className="px-4 py-3.5 space-y-3">
                                <SettingsInput
                                  label="Pass threshold (0-100)"
                                  description="Minimum aggregate score to pass the quality gate"
                                  value={qgPassThreshold}
                                  onChange={setQgPassThreshold}
                                  onBlur={handleQgThresholdBlur}
                                  placeholder="90"
                                />
                                <SettingsInput
                                  label="Max review cycles (1-10)"
                                  description="How many times to auto-retry before escalating"
                                  value={qgMaxCycles}
                                  onChange={setQgMaxCycles}
                                  onBlur={handleQgMaxCyclesBlur}
                                  placeholder="5"
                                />
                              </div>
                              <SettingsToggle
                                label="Enforce TDD"
                                description="Require tests before implementation for feature tasks"
                                checked={qgEnforceTDD}
                                onCheckedChange={handleQgTDDToggle}
                              />
                              <SettingsMenuSelectRow
                                label="Test Scope"
                                description="Which tests to run during per-task quality gates"
                                value={qgTestScope}
                                onValueChange={handleQgTestScopeChange}
                                options={[
                                  { value: 'affected', label: 'Affected Only', description: 'Tests related to changed files (vitest --changed)' },
                                  { value: 'full', label: 'Full Suite', description: 'Run the entire test suite on every task' },
                                  { value: 'none', label: 'Skip Tests', description: 'Disable test execution in quality gates' },
                                ]}
                              />
                            </SettingsCard>

                            {/* Review Model */}
                            <SettingsCard>
                            <SettingsMenuSelectRow
                              label="Review Model"
                              description="AI model used for architecture, simplicity, error, and completeness reviews (synced with Reviewer role)"
                              value={qgReviewModel}
                              onValueChange={handleQgReviewModelChange}
                              options={reviewModelOptions}
                            />
                            </SettingsCard>

                            {/* Stage Toggles */}
                            <SettingsCard>
                              <div className="px-4 py-2">
                                <p className="text-xs font-medium text-foreground mb-1">Review Stages</p>
                                <p className="text-xs text-muted-foreground">Toggle stages on/off. Hover <Info className="inline size-3 align-text-top" /> for what each gate checks and why to keep it enabled.</p>
                              </div>
                              <SettingsToggle
                                label={renderQualityHelpLabel('syntax', 'Syntax & Types')}
                                description="TypeScript compilation check (free, local)"
                                checked={qgSyntaxEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('syntax', v)}
                              />
                              <SettingsToggle
                                label={renderQualityHelpLabel('tests', 'Test Execution')}
                                description="Run test suite and verify all pass (free, local)"
                                checked={qgTestsEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('tests', v)}
                              />
                              <SettingsToggle
                                label={renderQualityHelpLabel('architecture', 'Architecture Review')}
                                description="File structure, separation of concerns, patterns (~$0.005)"
                                checked={qgArchEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('architecture', v)}
                              />
                              <SettingsToggle
                                label={renderQualityHelpLabel('simplicity', 'Simplicity Review')}
                                description="Code complexity, readability, unnecessary abstractions (~$0.005)"
                                checked={qgSimplicityEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('simplicity', v)}
                              />
                              <SettingsToggle
                                label={renderQualityHelpLabel('errors', 'Error Analysis')}
                                description="Edge cases, null handling, error paths, security (~$0.006)"
                                checked={qgErrorsEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('errors', v)}
                              />
                              <SettingsToggle
                                label={renderQualityHelpLabel('completeness', 'Completeness Check')}
                                description="All requirements met, no TODOs or stubs (~$0.005)"
                                checked={qgCompletenessEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('completeness', v)}
                              />
                            </SettingsCard>

                            <SettingsCard>
                              <SettingsToggle
                                label={renderQualityHelpLabel('baselineAwareTests', 'Baseline-aware Tests')}
                                description="Allow known pre-existing failing tests while still failing on newly introduced regressions"
                                checked={qgBaselineAwareTests}
                                onCheckedChange={handleQgBaselineAwareTestsToggle}
                              />
                              {qgBaselineAwareTests && (
                                <SettingsTextarea
                                  inCard
                                  label="Known failing tests baseline"
                                  description="Optional. One test identifier per line (or comma-separated). These are treated as pre-existing failures."
                                  value={qgKnownFailingTests}
                                  onChange={handleQgKnownFailingTestsChange}
                                  placeholder="packages/shared/src/foo/__tests__/bar.test.ts > handles legacy edge case"
                                  rows={4}
                                />
                              )}
                            </SettingsCard>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </SettingsSection>

                    {/* YOLO — Autonomous Execution */}
                    <SettingsSection
                      title="Autonomous Execution (YOLO)"
                      description="Fully autonomous orchestration engine. When enabled, YOLO takes an objective, generates a spec, decomposes it into tasks, spawns teammates, runs quality gates, auto-remediates failures, and synthesizes results — all without manual intervention. Pair with Spec Mode below for structured traceability, or use standalone for fast autonomous runs."
                      className="border-l-2 border-l-violet-500/50 pl-4"
                    >
                      <SettingsCard>
                        <SettingsRadioGroup
                          value={yoloMode}
                          onValueChange={handleYoloModeChange}
                        >
                          <SettingsRadioCard
                            value="off"
                            label="Off"
                            description="Manual orchestration only — you control the workflow"
                          />
                          <SettingsRadioCard
                            value="fixed"
                            label="Fixed Plan"
                            description="Autonomous execution following a fixed plan. Generates a spec, decomposes tasks, spawns teammates, and runs to completion without changing the plan."
                          />
                          <SettingsRadioCard
                            value="smart"
                            label="Smart (Adaptive)"
                            description="Same as Fixed, but can discover spec gaps at runtime and propose changes. Best for exploratory or complex work."
                          />
                        </SettingsRadioGroup>
                      </SettingsCard>

                      <AnimatePresence>
                        {yoloMode !== 'off' && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                            className="space-y-4 overflow-hidden"
                          >
                            <SettingsCard>
                              <div className="px-4 py-3.5 space-y-3">
                                <SettingsInput
                                  label="Cost cap (USD)"
                                  description="Auto-pause when spending reaches this limit"
                                  value={yoloCostCapUsd}
                                  onChange={setYoloCostCapUsd}
                                  onBlur={handleYoloCostCapBlur}
                                  placeholder="5"
                                />
                                <SettingsInput
                                  label="Timeout (minutes)"
                                  description="Auto-pause after this many minutes of wall-clock time"
                                  value={yoloTimeoutMinutes}
                                  onChange={setYoloTimeoutMinutes}
                                  onBlur={handleYoloTimeoutBlur}
                                  placeholder="60"
                                />
                                <SettingsInput
                                  label="Max concurrency"
                                  description="Maximum teammates working in parallel (1-10)"
                                  value={yoloMaxConcurrency}
                                  onChange={setYoloMaxConcurrency}
                                  onBlur={handleYoloMaxConcurrencyBlur}
                                  placeholder="3"
                                />
                              </div>
                              <SettingsToggle
                                label="Auto-remediate failures"
                                description="Automatically create fix-up tasks when quality gates or integration checks fail"
                                checked={yoloAutoRemediate}
                                onCheckedChange={handleYoloAutoRemediateToggle}
                              />
                              {yoloAutoRemediate && (
                                <div className="px-4 pb-3.5">
                                  <SettingsInput
                                    label="Max remediation rounds (0-10)"
                                    description="How many fix-up rounds before aborting (prevents infinite loops)"
                                    value={yoloMaxRemediationRounds}
                                    onChange={setYoloMaxRemediationRounds}
                                    onBlur={handleYoloMaxRemediationRoundsBlur}
                                    placeholder="3"
                                  />
                                </div>
                              )}
                            </SettingsCard>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </SettingsSection>

                    {/* Spec-Driven Development */}
                    <SettingsSection
                      title="Spec-Driven Development"
                      description="Structured requirement tracking for team work. Adds requirement IDs, DRI assignments, coverage gates, and compliance reports. Works independently of YOLO — use it for governance whether you drive the workflow manually or let YOLO automate it."
                      className="border-l-2 border-l-sky-500/50 pl-4"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Enable Spec Mode"
                          description="Track requirements with traceability and compliance checks"
                          checked={sddEnabled}
                          onCheckedChange={handleSddEnabledToggle}
                        />
                      </SettingsCard>

                      <AnimatePresence>
                        {sddEnabled && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                            className="space-y-4 overflow-hidden"
                          >
                            <SettingsCard>
                              <SettingsToggle
                                label="Require DRI Assignment"
                                description="Block task acceptance when requirements do not have a DRI owner"
                                checked={sddRequireDriAssignment}
                                onCheckedChange={handleSddRequireDriToggle}
                              />
                              <SettingsToggle
                                label="Require Full Coverage Before Completion"
                                description="Prevent completion until all requirements have linked tasks and tests"
                                checked={sddRequireFullCoverage}
                                onCheckedChange={handleSddRequireCoverageToggle}
                              />
                              <SettingsToggle
                                label="Auto-generate Compliance Reports"
                                description="Generate a requirement compliance report at the end of each spec run"
                                checked={sddAutoComplianceReports}
                                onCheckedChange={handleSddAutoComplianceToggle}
                              />
                              <SettingsMenuSelectRow
                                label="Default Spec Template"
                                description="Template used when creating a new spec in this workspace"
                                value={sddDefaultTemplate}
                                onValueChange={handleSddTemplateChange}
                                options={sddTemplateOptions}
                              />
                            </SettingsCard>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </SettingsSection>

                    {/* Design Flow */}
                    <SettingsSection
                      title="Design Flow"
                      description="Generate multiple UI design variants before coding begins. Detects your project stack, creates variants using your design system, and lets you select the best one before implementation."
                      className="border-l-2 border-l-emerald-500/50 pl-4"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Enable Design Flow"
                          description="Generate design variants during autonomous execution"
                          checked={designFlowEnabled}
                          onCheckedChange={handleDesignFlowToggle}
                        />
                      </SettingsCard>

                      <AnimatePresence>
                        {designFlowEnabled && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                            className="space-y-4 overflow-hidden"
                          >
                            <SettingsCard>
                              <SettingsMenuSelectRow
                                label="Variants Per Round"
                                description="Number of design variants to generate each round"
                                value={String(designFlowVariantsPerRound)}
                                onValueChange={handleDesignFlowVariantsChange}
                                options={[
                                  { value: '2', label: '2 Variants', description: 'Quick comparison' },
                                  { value: '4', label: '4 Variants', description: 'Balanced exploration (default)' },
                                  { value: '6', label: '6 Variants', description: 'Maximum variety' },
                                ]}
                              />
                              <SettingsMenuSelectRow
                                label="Design Model"
                                description="Model for design generation (defaults to Head model if not set)"
                                value={designFlowDesignModel || 'inherit'}
                                onValueChange={handleDesignFlowModelChange}
                                options={[
                                  { value: 'inherit', label: 'Inherit from Head', description: 'Use the Head role model' },
                                  ...roleModelOptions,
                                ]}
                              />
                              <SettingsToggle
                                label="Auto-save Templates"
                                description="Save selected designs as reusable workspace templates"
                                checked={designFlowAutoSaveTemplates}
                                onCheckedChange={handleDesignFlowAutoSaveToggle}
                              />
                            </SettingsCard>

                            {/* Template Library */}
                            <SettingsCard>
                              <div className="max-h-96">
                                <DesignTemplateLibrary
                                  templates={designTemplates}
                                  loading={designTemplatesLoading}
                                  onLoadDetail={handleLoadTemplateDetail}
                                  onDelete={handleDeleteTemplate}
                                />
                              </div>
                            </SettingsCard>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </SettingsSection>

                  </motion.div>
                )}
              </AnimatePresence>

            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
