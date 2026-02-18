import type { AgentTeammate } from '../../../shared/types'
import type { SessionMeta } from '@/atoms/sessions'

export interface TeamCardBucketsInput {
  teammates: AgentTeammate[]
  teammateActiveTaskCount: Map<string, number>
  sessionMetaMap: Map<string, SessionMeta>
  selectedTeammateId?: string
}

export interface TeamCardBucketsResult {
  visible: AgentTeammate[]
  minimized: AgentTeammate[]
}

/**
 * Implements REQ-001/REQ-003:
 * When a newer active cohort exists, bucket older inactive teammates into a minimized section.
 */
export function bucketTeamCards(input: TeamCardBucketsInput): TeamCardBucketsResult {
  const { teammates, teammateActiveTaskCount, sessionMetaMap, selectedTeammateId } = input
  const lead = teammates.filter((t) => t.isLead)
  const nonLead = teammates.filter((t) => !t.isLead)

  const isActiveLike = (teammate: AgentTeammate): boolean => {
    const activeCount = teammateActiveTaskCount.get(teammate.id) || 0
    return activeCount > 0 || teammate.status === 'working' || teammate.status === 'planning' || teammate.status === 'error'
  }

  const newestActiveCreatedAt = nonLead.reduce((max, teammate) => {
    if (!isActiveLike(teammate)) return max
    const createdAt = sessionMetaMap.get(teammate.id)?.createdAt || 0
    return Math.max(max, createdAt)
  }, 0)

  if (newestActiveCreatedAt <= 0) {
    return { visible: teammates, minimized: [] }
  }

  const visibleNonLead: AgentTeammate[] = []
  const minimized: AgentTeammate[] = []

  for (const teammate of nonLead) {
    const activeCount = teammateActiveTaskCount.get(teammate.id) || 0
    const createdAt = sessionMetaMap.get(teammate.id)?.createdAt || 0
    const inactive = activeCount === 0 && (teammate.status === 'idle' || teammate.status === 'shutdown')
    const olderThanCurrentCohort = createdAt > 0 && createdAt < newestActiveCreatedAt
    const forceVisible = selectedTeammateId === teammate.id

    if (!forceVisible && inactive && olderThanCurrentCohort) {
      minimized.push(teammate)
    } else {
      visibleNonLead.push(teammate)
    }
  }

  return {
    visible: [...lead, ...visibleNonLead],
    minimized,
  }
}

