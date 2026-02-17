# Agent Teams Knowledge + Learning Retention Policy (REQ-009)

## Scope
- Knowledge entries persisted in `sessions/{leadSessionId}/team-state.jsonl` (`t="kb"` rows).
- Learning telemetry persisted in `.craft-agent/agent-team-learning.json` (`qualityEvents`, `knowledgeEvents`).

## Enforcement
- Knowledge retention window: **14 days** default (`KNOWLEDGE_RETENTION_DAYS`).
- TTL-bound knowledge entries are pruned immediately when expired.
- TeamStateStore rewrites compacted JSONL state after retention pruning to keep disk artifacts bounded.
- Learning retention window: **30 days** (`LEARNING_RETENTION_DAYS`) for quality + knowledge telemetry events.
- Learning events are additionally bounded by max-entry caps (`MAX_QUALITY_EVENTS=300`, `MAX_KNOWLEDGE_EVENTS=2000`).

## Adoption Outcome Tracking (REQ-010)
- Measurement windows: rolling **7-day current** vs **previous 7-day baseline** (`ADOPTION_WINDOW_DAYS`).
- Usage metrics: query count, injection count, injection hit rate.
- Quality impact metrics: pass rate, retry rate, escalation rate, average score.

### Default success thresholds
- Min runs per window: 6
- Min query events: 8
- Min injection hit rate: 55%
- Max retry-rate increase vs baseline: +8pp
- Max escalation-rate increase vs baseline: +5pp
- Min current pass rate: 75%

Use `getLearningAdoptionSummary()` for operational readouts and rollout decisions.
