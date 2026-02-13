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
import { Button } from '@/components/ui/button'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ModelPresetId, ModelAssignment, WorkspaceSettings } from '../../../shared/types'
import { OPENAI_MODELS, isCodexModel } from '@config/models'
import { isOpenAIProvider } from '@config/llm-connections'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsMenuSelectRow,
  SettingsInput,
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


// Preset configurations
const PRESET_OPTIONS: { id: ModelPresetId; name: string; description: string; cost: string }[] = [
  { id: 'max-quality', name: 'Max Quality', description: 'Opus everywhere', cost: '$$$$' },
  { id: 'balanced', name: 'Balanced', description: 'Opus lead, Sonnet workers', cost: '$$$' },
  { id: 'cost-optimized', name: 'Cost Optimized', description: 'Opus lead, Kimi workers', cost: '$$' },
  { id: 'budget', name: 'Budget', description: 'Sonnet lead, Kimi workers', cost: '$' },
  { id: 'codex-balanced', name: 'Codex Balanced', description: 'Codex lead/head, Sonnet workers', cost: '$$$' },
  { id: 'codex-full', name: 'Codex Full', description: 'Codex everywhere', cost: '$$$$' },
  { id: 'custom', name: 'Custom', description: 'Choose every role', cost: '' },
]

const PRESET_CONFIGS: Record<ModelPresetId, { lead: string; head: string; worker: string; reviewer: string; escalation: string }> = {
  'max-quality': { lead: 'claude-opus-4-6', head: 'claude-opus-4-6', worker: 'claude-opus-4-6', reviewer: 'claude-sonnet-4-5-20250929', escalation: 'claude-opus-4-6' },
  'balanced': { lead: 'claude-opus-4-6', head: 'claude-sonnet-4-5-20250929', worker: 'claude-sonnet-4-5-20250929', reviewer: 'kimi-k2.5', escalation: 'claude-opus-4-6' },
  'cost-optimized': { lead: 'claude-opus-4-6', head: 'claude-sonnet-4-5-20250929', worker: 'kimi-k2.5', reviewer: 'kimi-k2.5', escalation: 'claude-sonnet-4-5-20250929' },
  'budget': { lead: 'claude-sonnet-4-5-20250929', head: 'kimi-k2.5', worker: 'kimi-k2.5', reviewer: 'kimi-k2.5', escalation: 'claude-sonnet-4-5-20250929' },
  'codex-balanced': { lead: 'gpt-5.3-codex', head: 'gpt-5.3-codex', worker: 'claude-sonnet-4-5-20250929', reviewer: 'kimi-k2.5', escalation: 'claude-sonnet-4-5-20250929' },
  'codex-full': { lead: 'gpt-5.3-codex', head: 'gpt-5.3-codex', worker: 'gpt-5.1-codex-mini', reviewer: 'kimi-k2.5', escalation: 'claude-opus-4-6' },
  'custom': { lead: 'claude-opus-4-6', head: 'claude-sonnet-4-5-20250929', worker: 'claude-sonnet-4-5-20250929', reviewer: 'kimi-k2.5', escalation: 'claude-opus-4-6' },
}

// Helper to get provider from model ID
function getProvider(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('kimi-')) return 'moonshot'
  return 'openrouter'
}

export default function AgentTeamsSettingsPage() {
  const { activeWorkspaceId, llmConnections } = useAppShellContext()

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

  // Provider API keys (stored in encrypted secure storage, not plaintext config)
  const [moonshotApiKey, setMoonshotApiKey] = useState('')
  const [moonshotKeyStored, setMoonshotKeyStored] = useState(false)
  const [openrouterApiKey, setOpenrouterApiKey] = useState('')
  const [openrouterKeyStored, setOpenrouterKeyStored] = useState(false)

  // Cost cap
  const [costCapEnabled, setCostCapEnabled] = useState(false)
  const [costCapUsd, setCostCapUsd] = useState('10')

  // Quality gate settings
  const [qgEnabled, setQgEnabled] = useState(true)
  const [qgPassThreshold, setQgPassThreshold] = useState('90')
  const [qgMaxCycles, setQgMaxCycles] = useState('5')
  const [qgEnforceTDD, setQgEnforceTDD] = useState(true)
  const [qgReviewModel, setQgReviewModel] = useState('kimi-k2.5')
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

  const hasOpenAiConnection = (llmConnections || []).some((conn) => isOpenAIProvider(conn.providerType))

  // Load settings
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI || !activeWorkspaceId) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const enabled = await window.electronAPI.getAgentTeamsEnabled(activeWorkspaceId)
        setTeamsEnabled(enabled)

        // Load workspace settings for model config
        const settings = await window.electronAPI.getWorkspaceSettings(activeWorkspaceId)
        if (settings?.agentTeamsModelPreset) {
          setSelectedPreset(settings.agentTeamsModelPreset as ModelPresetId)
        }
        if (settings?.agentTeamsLeadModel) setLeadModel(settings.agentTeamsLeadModel)
        if (settings?.agentTeamsHeadModel) setHeadModel(settings.agentTeamsHeadModel)
        if (settings?.agentTeamsWorkerModel) setWorkerModel(settings.agentTeamsWorkerModel)
        if (settings?.agentTeamsReviewerModel) {
          setReviewerModel(settings.agentTeamsReviewerModel)
          setQgReviewModel(settings.agentTeamsReviewerModel)
        }
        if (settings?.agentTeamsEscalationModel) setEscalationModel(settings.agentTeamsEscalationModel)
        if (settings?.agentTeamsCostCapUsd) {
          setCostCapEnabled(true)
          setCostCapUsd(String(settings.agentTeamsCostCapUsd))
        }

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
        if (settings?.qualityGatesSyntaxEnabled !== undefined) setQgSyntaxEnabled(settings.qualityGatesSyntaxEnabled)
        if (settings?.qualityGatesTestsEnabled !== undefined) setQgTestsEnabled(settings.qualityGatesTestsEnabled)
        if (settings?.qualityGatesArchEnabled !== undefined) setQgArchEnabled(settings.qualityGatesArchEnabled)
        if (settings?.qualityGatesSimplicityEnabled !== undefined) setQgSimplicityEnabled(settings.qualityGatesSimplicityEnabled)
        if (settings?.qualityGatesErrorsEnabled !== undefined) setQgErrorsEnabled(settings.qualityGatesErrorsEnabled)
        if (settings?.qualityGatesCompletenessEnabled !== undefined) setQgCompletenessEnabled(settings.qualityGatesCompletenessEnabled)
        if (settings?.sddEnabled !== undefined) setSddEnabled(settings.sddEnabled)
        if (settings?.sddRequireDRIAssignment !== undefined) setSddRequireDriAssignment(settings.sddRequireDRIAssignment)
        if (settings?.sddRequireFullCoverage !== undefined) setSddRequireFullCoverage(settings.sddRequireFullCoverage)
        if (settings?.sddAutoComplianceReports !== undefined) setSddAutoComplianceReports(settings.sddAutoComplianceReports)
        if (settings?.sddDefaultSpecTemplate) setSddDefaultTemplate(settings.sddDefaultSpecTemplate)
        if (settings?.sddSpecTemplates && settings.sddSpecTemplates.length > 0) {
          setSddTemplateOptions(settings.sddSpecTemplates.map((template) => ({
            value: template.id,
            label: template.name,
            description: template.description,
          })))
        }

        // Load provider API key status from secure storage
        const [moonshotStatus, openrouterStatus] = await Promise.all([
          window.electronAPI.getAgentTeamsProviderKey('moonshot'),
          window.electronAPI.getAgentTeamsProviderKey('openrouter'),
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
  }, [activeWorkspaceId])

  // Save workspace setting helper
  const saveSetting = useCallback(
    async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
      if (!window.electronAPI || !activeWorkspaceId) return
      try {
        await window.electronAPI.updateWorkspaceSetting(activeWorkspaceId, key, value)
      } catch (error) {
        console.error(`Failed to save ${key}:`, error)
      }
    },
    [activeWorkspaceId]
  )

  // Toggle handler
  const handleTeamsToggle = useCallback(
    async (enabled: boolean) => {
      setTeamsEnabled(enabled)
      if (!window.electronAPI || !activeWorkspaceId) return
      try {
        await window.electronAPI.setAgentTeamsEnabled(activeWorkspaceId, enabled)
      } catch (error) {
        console.error('Failed to toggle agent teams:', error)
      }
    },
    [activeWorkspaceId]
  )

  // Preset change handler
  const handlePresetChange = useCallback(
    (presetId: string) => {
      const id = presetId as ModelPresetId
      setSelectedPreset(id)
      saveSetting('agentTeamsModelPreset', id)

      if (id !== 'custom') {
        const config = PRESET_CONFIGS[id]
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
    if (!window.electronAPI || !moonshotApiKey || moonshotApiKey.includes('*')) return
    try {
      await window.electronAPI.setAgentTeamsProviderKey('moonshot', moonshotApiKey)
      setMoonshotKeyStored(true)
      // Replace with masked version for display
      const status = await window.electronAPI.getAgentTeamsProviderKey('moonshot')
      if (status?.maskedKey) setMoonshotApiKey(status.maskedKey)
    } catch (error) {
      console.error('Failed to save Moonshot API key:', error)
    }
  }, [moonshotApiKey])

  const handleOpenrouterKeyFocus = useCallback(() => {
    if (openrouterKeyStored) {
      setOpenrouterApiKey('')
    }
  }, [openrouterKeyStored])

  const handleOpenrouterKeyBlur = useCallback(async () => {
    if (!window.electronAPI || !openrouterApiKey || openrouterApiKey.includes('*')) return
    try {
      await window.electronAPI.setAgentTeamsProviderKey('openrouter', openrouterApiKey)
      setOpenrouterKeyStored(true)
      const status = await window.electronAPI.getAgentTeamsProviderKey('openrouter')
      if (status?.maskedKey) setOpenrouterApiKey(status.maskedKey)
    } catch (error) {
      console.error('Failed to save OpenRouter API key:', error)
    }
  }, [openrouterApiKey])

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

  const hasCodexConnection = llmConnections.some((conn) =>
    isOpenAIProvider(conn.providerType) && conn.isAuthenticated
  )

  const codexSelected = [leadModel, headModel, workerModel, reviewerModel, escalationModel, qgReviewModel].some((model) =>
    isCodexModel(model)
  )

  const roleModelOptions = React.useMemo(() => {
    if (hasCodexConnection || codexSelected) {
      return [
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('claude-')),
        ...CODEX_MODEL_OPTIONS,
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('kimi-')),
      ]
    }
    return BASE_MODEL_OPTIONS
  }, [hasCodexConnection, codexSelected])

  const reviewModelOptions = React.useMemo(() => {
    if (hasCodexConnection || codexSelected) {
      return [
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('claude-')),
        ...CODEX_MODEL_OPTIONS,
        ...BASE_MODEL_OPTIONS.filter((o) => o.value.startsWith('kimi-')),
      ]
    }
    return BASE_MODEL_OPTIONS
  }, [hasCodexConnection, codexSelected])

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

                    {/* Model Preset */}
                    <SettingsSection
                      title="Model Preset"
                      description="Choose a pre-configured model mix for your teams"
                    >
                      <SettingsRadioGroup
                        value={selectedPreset}
                        onValueChange={handlePresetChange}
                      >
                        {PRESET_OPTIONS.map((preset) => (
                          <SettingsRadioCard
                            key={preset.id}
                            value={preset.id}
                            label={preset.name}
                            description={`${preset.description}${preset.cost ? ` — ${preset.cost}` : ''}`}
                          />
                        ))}
                      </SettingsRadioGroup>
                    </SettingsSection>

                    {/* Per-role model assignment is only shown for Custom preset */}
                    {selectedPreset === 'custom' && (
                      <SettingsSection
                        title="Role Models"
                        description="Model assigned to each role in the team hierarchy"
                      >
                        <SettingsCard>
                          <div className="px-4 py-3 border-b border-border/60 bg-foreground/[0.02]">
                            <div className="flex items-start gap-2">
                              <Info className="size-4 mt-0.5 text-muted-foreground shrink-0" />
                              <div className="space-y-1">
                                <p className="text-xs font-medium">Suggested defaults for speed + quality</p>
                                <p className="text-xs text-muted-foreground">Lead: Opus/Codex (planning) · Head: Sonnet/Codex (coordination) · Worker: Sonnet/Haiku/Kimi (throughput) · Reviewer: Sonnet/Kimi (fast checks) · Escalation: Opus/Codex (hard blockers).</p>
                              </div>
                            </div>
                          </div>
                          <SettingsMenuSelectRow
                            label="Lead"
                            description="Orchestrator that plans work and delegates"
                            value={leadModel}
                            onValueChange={handleLeadChange}
                            options={roleModelOptions}
                          />
                          <SettingsMenuSelectRow
                            label="Head"
                            description="Coordinates sub-teams or complex sub-tasks"
                            value={headModel}
                            onValueChange={handleHeadChange}
                            options={roleModelOptions}
                          />
                          <SettingsMenuSelectRow
                            label="Worker"
                            description="Executes individual tasks"
                            value={workerModel}
                            onValueChange={handleWorkerChange}
                            options={roleModelOptions}
                          />
                          <SettingsMenuSelectRow
                            label="Reviewer"
                            description="Reviews teammate output in quality gates"
                            value={reviewerModel}
                            onValueChange={handleReviewerChange}
                            options={reviewModelOptions}
                          />
                          <SettingsMenuSelectRow
                            label="Escalation"
                            description="Handles worker failures or review rejections"
                            value={escalationModel}
                            onValueChange={handleEscalationChange}
                            options={roleModelOptions}
                          />
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

                    {/* Quality Gates */}
                    <SettingsSection
                      title="Quality Gates"
                      description="Automated code review pipeline — every piece of teammate code is reviewed, scored, and rejected if below threshold"
                    >
                      <SettingsCard>
                        <SettingsToggle
                          label="Enable Quality Gates"
                          description="Automatically review teammate work before relaying to team lead"
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
                                <p className="text-xs text-muted-foreground">Toggle individual review stages on or off</p>
                              </div>
                              <SettingsToggle
                                label="Syntax & Types"
                                description="TypeScript compilation check (free, local)"
                                checked={qgSyntaxEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('syntax', v)}
                              />
                              <SettingsToggle
                                label="Test Execution"
                                description="Run test suite and verify all pass (free, local)"
                                checked={qgTestsEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('tests', v)}
                              />
                              <SettingsToggle
                                label="Architecture Review"
                                description="File structure, separation of concerns, patterns (~$0.005)"
                                checked={qgArchEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('architecture', v)}
                              />
                              <SettingsToggle
                                label="Simplicity Review"
                                description="Code complexity, readability, unnecessary abstractions (~$0.005)"
                                checked={qgSimplicityEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('simplicity', v)}
                              />
                              <SettingsToggle
                                label="Error Analysis"
                                description="Edge cases, null handling, error paths, security (~$0.006)"
                                checked={qgErrorsEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('errors', v)}
                              />
                              <SettingsToggle
                                label="Completeness Check"
                                description="All requirements met, no TODOs or stubs (~$0.005)"
                                checked={qgCompletenessEnabled}
                                onCheckedChange={(v) => handleQgStageToggle('completeness', v)}
                              />
                            </SettingsCard>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </SettingsSection>

                    {/* Spec-Driven Development */}
                    <SettingsSection
                      title="Spec-Driven Development"
                      description="Enable spec-centric planning, coverage, and compliance workflows"
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
