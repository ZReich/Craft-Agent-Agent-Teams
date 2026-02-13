/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { TeamActivityFeed } from '../TeamActivityFeed'
import type { TeamActivityEvent } from '../../../../shared/types'

expect.extend(matchers)

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
})

function makeEvent(partial: Partial<TeamActivityEvent>): TeamActivityEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    timestamp: partial.timestamp ?? new Date('2026-02-13T16:05:00.000Z').toISOString(),
    type: partial.type ?? 'message-sent',
    details: partial.details ?? 'event details',
    teammateName: partial.teammateName,
    teammateId: partial.teammateId,
    teamId: partial.teamId,
    taskId: partial.taskId,
  }
}

describe('TeamActivityFeed', () => {
  it('shows YOLO lifecycle events in Tasks filter', () => {
    const events: TeamActivityEvent[] = [
      makeEvent({ id: '1', type: 'yolo-started', details: 'YOLO run started' }),
      makeEvent({ id: '2', type: 'yolo-phase-changed', details: 'Phase changed to reviewing' }),
      makeEvent({ id: '3', type: 'message-sent', details: 'Lead sent update' }),
    ]

    render(<TeamActivityFeed events={events} />)

    fireEvent.click(screen.getByRole('button', { name: /^Tasks$/i }))

    expect(screen.getByText('YOLO run started')).toBeInTheDocument()
    expect(screen.getByText('Phase changed to reviewing')).toBeInTheDocument()
    expect(screen.queryByText('Lead sent update')).not.toBeInTheDocument()
  })

  it('keeps message events under Messages filter only', () => {
    const events: TeamActivityEvent[] = [
      makeEvent({ id: 'm1', type: 'message-sent', details: 'mailbox message' }),
      makeEvent({ id: 't1', type: 'task-completed', details: 'task done' }),
    ]

    render(<TeamActivityFeed events={events} />)

    fireEvent.click(screen.getByRole('button', { name: /^Messages$/i }))

    expect(screen.getByText('mailbox message')).toBeInTheDocument()
    expect(screen.queryByText('task done')).not.toBeInTheDocument()
  })
})
