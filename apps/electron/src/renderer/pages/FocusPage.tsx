/**
 * FocusPage
 *
 * Full-screen focused view for deep work on a single session.
 * Includes main chat panel, optional right context pane, and timeline drawer.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronLeft, ChevronRight, Clock, FileText, X } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useAppShellContext, usePendingPermission, usePendingCredential, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { ensureSessionMessagesLoadedAtom, loadedSessionsAtom, sessionMetaMapAtom } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import { cn } from '@/lib/utils'
import { routes, navigate } from '@/lib/navigate'
import { useNavigation } from '@/contexts/NavigationContext'

export interface FocusPageProps {
  sessionId: string
  /** Whether the right context pane is visible */
  contextPaneVisible?: boolean
  /** Whether the timeline drawer is visible */
  timelineDrawerVisible?: boolean
}

export const FocusPage = React.memo(function FocusPage({
  sessionId,
  contextPaneVisible = false,
  timelineDrawerVisible = false,
}: FocusPageProps) {
  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionRead,
    onSetActiveViewingSession,
    textareaRef,
    getDraft,
    onInputChange,
    enabledSources,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    todoStates,
    onSessionSourcesChange,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onTodoStateChange,
    onDeleteSession,
    chatDisplayRef,
    onChatMatchInfoChange,
  } = useAppShellContext()

  const { navigate: navNavigate } = useNavigation()

  // Use the unified session options hook
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom
  const session = useSessionData(sessionId)

  // Track if messages are loaded
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check session metadata
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Ensure messages are loaded
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  React.useEffect(() => {
    if (sessionMeta) {
      ensureMessagesLoaded(sessionId)
    }
  }, [sessionId, sessionMeta, ensureMessagesLoaded])

  // Track window focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Mark session as being viewed
  React.useEffect(() => {
    if (session && isWindowFocused) {
      onSetActiveViewingSession(session.id)
    }
  }, [session, isWindowFocused, onSetActiveViewingSession])

  // Get pending requests
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)

  // Input state
  const [inputValue, setInputValue] = React.useState(() => getDraft(sessionId))
  React.useEffect(() => {
    setInputValue(getDraft(sessionId))
  }, [getDraft, sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    setInputValue(value)
    onInputChange(sessionId, value)
  }, [sessionId, onInputChange])

  const handleSendMessage = React.useCallback(async (message: string, attachments?: any[], skillSlugs?: string[], externalBadges?: any[]) => {
    await onSendMessage(sessionId, message, attachments, skillSlugs, externalBadges)
    setInputValue('')
  }, [sessionId, onSendMessage])

  // Effective model for this session
  const effectiveModel = session?.model || workspaceDefaultLlmConnection || ''
  const handleModelChange = React.useCallback((model: string, connection?: string) => {
    // Model changes are handled by the session
    if (activeWorkspaceId) {
      window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
    }
  }, [sessionId, activeWorkspaceId])

  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

  // Rename dialog
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')

  // Toggle functions for panes
  const [localContextVisible, setLocalContextVisible] = React.useState(contextPaneVisible)
  const [localTimelineVisible, setLocalTimelineVisible] = React.useState(timelineDrawerVisible)

  const toggleContextPane = React.useCallback(() => {
    setLocalContextVisible(prev => !prev)
  }, [])

  const toggleTimelineDrawer = React.useCallback(() => {
    setLocalTimelineVisible(prev => !prev)
  }, [])

  // Exit focus mode
  const exitFocusMode = React.useCallback(() => {
    navNavigate(routes.view.allSessions(sessionId))
  }, [navNavigate, sessionId])

  // Session menu handlers
  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionRead(sessionId)
  }, [sessionId, onMarkSessionRead])

  const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

  const handleTodoStateChange = React.useCallback((state: string) => {
    onTodoStateChange(sessionId, state)
  }, [sessionId, onTodoStateChange])

  const handleOpenInNewWindow = React.useCallback(() => {
    if (activeWorkspaceId) {
      window.electronAPI.openSessionInNewWindow(activeWorkspaceId, sessionId)
    }
  }, [sessionId, activeWorkspaceId])

  // Implements REQ-002: Agent Teams toggle handler
  const handleAgentTeamsChange = React.useCallback((enabled: boolean) => {
    setOption('agentTeamsEnabled', enabled)
    if (activeWorkspaceId) {
      window.electronAPI.setAgentTeamsEnabled(activeWorkspaceId, enabled)
    }
  }, [setOption, activeWorkspaceId])

  // Implements REQ-003, REQ-005: YOLO Mode toggle handler
  const handleYoloModeChange = React.useCallback((enabled: boolean) => {
    if (enabled) {
      setOption('preYoloPermissionMode', sessionOpts.permissionMode)
      setOption('yoloModeEnabled', true)
      setPermissionMode('allow-all')
    } else {
      const restoreMode = sessionOpts.preYoloPermissionMode ?? 'ask'
      setOption('yoloModeEnabled', false)
      setPermissionMode(restoreMode)
    }
  }, [setOption, setPermissionMode, sessionOpts.permissionMode, sessionOpts.preYoloPermissionMode])

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading session...</p>
      </div>
    )
  }

  const sessionTitle = getSessionTitle(session)

  // Derive session menu props
  const isFlagged = session?.isFlagged || sessionMeta?.isFlagged || false
  const isArchived = session?.isArchived || sessionMeta?.isArchived || false
  const currentTodoState = session?.todoState || sessionMeta?.todoState || 'todo'
  const hasMessages = !!(session?.messages?.length || sessionMeta?.lastFinalMessageId)
  const hasUnreadMessages = sessionMeta?.hasUnread || false
  const sharedUrl = session?.sharedUrl || null
  const sessionLabels = session?.labels || []

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header */}
      <div className="flex items-center h-[40px] pr-2 pl-2 gap-1">
        <HeaderIconButton
          icon={<ChevronLeft className="h-4 w-4" />}
          tooltip="Exit Focus Mode"
          onClick={exitFocusMode}
        />
        <PanelHeader
          title={sessionTitle}
          actions={
            <div className="flex items-center gap-1">
              <HeaderIconButton
                icon={<Clock className="h-4 w-4" />}
                tooltip={localTimelineVisible ? "Hide Timeline" : "Show Timeline"}
                onClick={toggleTimelineDrawer}
                className={cn(localTimelineVisible && "bg-accent")}
              />
              <HeaderIconButton
                icon={<FileText className="h-4 w-4" />}
                tooltip={localContextVisible ? "Hide Context" : "Show Context"}
                onClick={toggleContextPane}
                className={cn(localContextVisible && "bg-accent")}
              />
              <SessionMenu
                sessionId={sessionId}
                sessionName={sessionTitle}
                isFlagged={isFlagged}
                isArchived={isArchived}
                sharedUrl={sharedUrl}
                hasMessages={hasMessages}
                hasUnreadMessages={hasUnreadMessages}
                currentTodoState={currentTodoState}
                todoStates={todoStates || []}
                sessionLabels={sessionLabels}
                labels={labels || []}
                onLabelsChange={handleLabelsChange}
                onRename={() => {
                  setRenameValue(session.name || '')
                  setRenameDialogOpen(true)
                }}
                onFlag={() => onFlagSession(sessionId)}
                onUnflag={() => onUnflagSession(sessionId)}
                onArchive={() => onArchiveSession(sessionId)}
                onUnarchive={() => onUnarchiveSession(sessionId)}
                onMarkUnread={handleMarkUnread}
                onTodoStateChange={handleTodoStateChange}
                onOpenInNewWindow={handleOpenInNewWindow}
                onDelete={() => onDeleteSession(sessionId)}
              />
            </div>
          }
        />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            onSendMessage={handleSendMessage}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onConnectionChange={handleConnectionChange}
            textareaRef={textareaRef}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            ultrathinkEnabled={sessionOpts.ultrathinkEnabled}
            onUltrathinkChange={(enabled) => setOption('ultrathinkEnabled', enabled)}
            permissionMode={sessionOpts.permissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            sources={enabledSources}
            skills={skills}
            workspaceId={activeWorkspaceId || undefined}
            agentTeamsEnabled={sessionOpts.agentTeamsEnabled}
            onAgentTeamsChange={handleAgentTeamsChange}
            yoloModeEnabled={sessionOpts.yoloModeEnabled}
            onYoloModeChange={handleYoloModeChange}
          />
        </div>

        {/* Right context pane */}
        <AnimatePresence initial={false}>
          {localContextVisible && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="border-l border-border bg-background overflow-hidden"
            >
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <h3 className="text-sm font-medium">Context</h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={toggleContextPane}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-4">
                    <div className="text-sm text-muted-foreground">
                      <p className="font-medium mb-2">Session Context</p>
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <FileText className="h-4 w-4 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs">Related files, references, and context will appear here.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </ScrollArea>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Timeline drawer */}
      <AnimatePresence initial={false}>
        {localTimelineVisible && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 200, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="border-t border-border bg-background overflow-hidden"
          >
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                <h3 className="text-sm font-medium">Timeline</h3>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={toggleTimelineDrawer}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4">
                  <div className="text-sm text-muted-foreground text-center">
                    <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>Session timeline and activity history will appear here.</p>
                  </div>
                </div>
              </ScrollArea>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rename dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title="Rename Session"
        value={renameValue}
        onValueChange={setRenameValue}
        onSubmit={() => {
          onRenameSession(sessionId, renameValue)
          setRenameDialogOpen(false)
        }}
      />
    </div>
  )
})
