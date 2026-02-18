import { describe, expect, it } from 'vitest'
import type { AgentTeammate } from '../../../../shared/types'
import type { SessionMeta } from '@/atoms/sessions'
import { bucketTeamCards } from '../team-dashboard-card-buckets'

function teammate(id: string, status: AgentTeammate['status'], isLead = false): AgentTeammate {
  return {
    id,
    name: id,
    role: isLead ? 'lead' : 'worker',
    agentId: id,
    sessionId: id,
    status,
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    isLead,
  }
}

function meta(createdAt: number): SessionMeta {
  return {
    id: `m-${createdAt}`,
    workspaceId: 'ws',
    createdAt,
  }
}

describe('bucketTeamCards', () => {
  it('minimizes older inactive teammates when a newer active cohort exists', () => {
    const teammates = [
      teammate('lead', 'idle', true),
      teammate('old-worker', 'idle'),
      teammate('new-worker', 'working'),
    ]
    const counts = new Map<string, number>([['new-worker', 1]])
    const metaMap = new Map<string, SessionMeta>([
      ['lead', meta(100)],
      ['old-worker', meta(200)],
      ['new-worker', meta(300)],
    ])

    const result = bucketTeamCards({
      teammates,
      teammateActiveTaskCount: counts,
      sessionMetaMap: metaMap,
    })

    expect(result.visible.map((t) => t.id)).toEqual(['lead', 'new-worker'])
    expect(result.minimized.map((t) => t.id)).toEqual(['old-worker'])
  })

  it('keeps selected older teammate visible', () => {
    const teammates = [
      teammate('lead', 'idle', true),
      teammate('old-worker', 'idle'),
      teammate('new-worker', 'working'),
    ]
    const counts = new Map<string, number>([['new-worker', 1]])
    const metaMap = new Map<string, SessionMeta>([
      ['lead', meta(100)],
      ['old-worker', meta(200)],
      ['new-worker', meta(300)],
    ])

    const result = bucketTeamCards({
      teammates,
      teammateActiveTaskCount: counts,
      sessionMetaMap: metaMap,
      selectedTeammateId: 'old-worker',
    })

    expect(result.visible.map((t) => t.id)).toContain('old-worker')
    expect(result.minimized.map((t) => t.id)).toEqual([])
  })
})

