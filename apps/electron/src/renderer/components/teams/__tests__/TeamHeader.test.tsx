/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { AgentTeam } from '../../../../shared/types'

expect.extend(matchers)

vi.mock('@craft-agent/ui', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { TeamHeader } from '../TeamHeader'

function createTeam(): AgentTeam {
  return {
    id: 'team-1',
    name: 'Test Team',
    leadSessionId: 'session-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    members: [
      {
        id: 'session-1',
        name: 'Lead',
        role: 'lead',
        agentId: 'session-1',
        sessionId: 'session-1',
        status: 'idle',
        model: 'claude-sonnet-4.5',
        provider: 'anthropic',
        isLead: true,
      },
    ],
    delegateMode: false,
  }
}

describe('TeamHeader draft badge', () => {
  it('renders clickable Draft Spec badge when spec is draft', () => {
    render(
      <TeamHeader
        team={createTeam()}
        specModeEnabled
        specIsDraft
      />
    )

    expect(screen.getByText('Draft Spec')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /why this spec is marked as draft/i })).toBeInTheDocument()
  })
})
