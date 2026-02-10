# Task Tool Completion Gating - Quick Reference

**Status**: Investigation Complete
**Date**: 2026-02-09
**Requirements**: REQ-001, REQ-003

---

## 🎯 Key Findings

### ClaudeAgent: ✅ CORRECT
- **Has state tracking**: `activeTeamName`, `activeTeammateCount`
- **Sets state on spawn**: Lines 920-927
- **Gates completion**: Lines 2573-2589
- **Condition**: `this.activeTeamName && this.activeTeammateCount > 0`

### CodexAgent: ❌ MISSING
- **No state tracking**: Missing properties
- **No spawn tracking**: Lines 1157-1192 don't set state
- **No completion gating**: Lines 427-441, 1933-1936, 1965-1966 always emit complete
- **Risk**: Sessions terminate prematurely while teammates are working

---

## 🔧 Recommended Fix (5 Steps)

### 1. Add State Properties (After line 211)
```typescript
// Agent teams: Track active team state
private activeTeamName: string | null = null;
private activeTeammateCount: number = 0;
```

### 2. Track Spawns (Lines 1157-1192, after line 1162)
```typescript
// CRITICAL: Set state BEFORE async call
if (!this.activeTeamName) {
  this.activeTeamName = teamName;
}
this.activeTeammateCount++;
```

### 3. Gate turn/completed (Lines 427-441)
```typescript
if (event.type === 'complete') {
  if (this.activeTeamName && this.activeTeammateCount > 0) {
    // Team active - emit usage_update, stay alive
    this.enqueueEvent({ type: 'usage_update', usage: { ... } });
  } else {
    // Normal completion
    this.enqueueEvent({ type: 'complete', usage });
  }
}
```

### 4. Gate Fallback Completion (Lines 1933-1936)
```typescript
if (!this.turnComplete) {
  if (!(this.activeTeamName && this.activeTeammateCount > 0)) {
    yield { type: 'complete' };
  }
}
```

### 5. Add Reset Method
```typescript
public clearTeamState(): void {
  this.activeTeamName = null;
  this.activeTeammateCount = 0;
}
```

---

## 🧪 Testing Checklist

- [ ] No complete event when team is active (REQ-001)
- [ ] Emit usage_update when team is active
- [ ] Normal completion when no team (REQ-003)
- [ ] Complete when team has zero teammates
- [ ] Transition from usage_update to complete when team finishes

**Test file**: `packages/shared/src/agent/__tests__/codex-agent-completion.test.ts`

---

## 📊 The Gating Condition

```typescript
if (this.activeTeamName && this.activeTeammateCount > 0) {
  // ✅ TEAM IS ACTIVE
  // - emit usage_update
  // - keep session alive
  // - lead continues coordinating
} else {
  // ❌ NO ACTIVE TEAM
  // - emit complete
  // - terminate session normally
}
```

**Why both checks?**
- `activeTeamName`: Team was created
- `activeTeammateCount > 0`: Teammates actually exist

**Edge cases handled**:
- Team created but no teammates → Complete
- All teammates shut down → Complete
- Spawn failed → Complete

---

## 📁 Files to Modify

| File | Lines | Action |
|------|-------|--------|
| `codex-agent.ts` | After 211 | Add state properties |
| `codex-agent.ts` | 1157-1192 | Track spawns (after 1162) |
| `codex-agent.ts` | 427-441 | Gate turn/completed |
| `codex-agent.ts` | 1933-1936 | Gate fallback |
| `codex-agent.ts` | Any | Add clearTeamState() |
| `codex-agent-completion.test.ts` | New | Write 5 test cases |

---

## 🎨 Visual Reference

See [completion-flow-diagram.md](./completion-flow-diagram.md) for:
- Current vs. proposed flow diagrams
- State lifecycle
- Decision tree
- Multi-agent sequence diagram

---

## 📚 Full Analysis

See [task-tool-completion-gating.md](./task-tool-completion-gating.md) for:
- Detailed code analysis
- Alternative approaches
- Risk assessment
- Complete implementation guide

---

## ⚠️ Critical Timing Note

State MUST be set **before** the async `onTeammateSpawnRequested()` call returns:

```typescript
// ✅ CORRECT - set state first
if (!this.activeTeamName) {
  this.activeTeamName = teamName;
}
this.activeTeammateCount++;

const result = await this.onTeammateSpawnRequested({ ... });

// ❌ WRONG - too late, turn might complete before state is set
const result = await this.onTeammateSpawnRequested({ ... });
this.activeTeammateCount++; // Race condition!
```

This ensures the completion handler sees the active team flag even if the turn completes rapidly.

---

## 🔗 Requirements Traceability

- **REQ-001**: Lead agent does not emit `complete` event when team is active
  - **Implementation**: Gating condition blocks complete, emits usage_update
  - **Location**: `codex-agent.ts:427-441` (proposed)

- **REQ-003**: Lead agent emits `complete` normally when no team is active
  - **Implementation**: Else branch of gating condition
  - **Location**: `codex-agent.ts:427-441` (proposed)

---

**Next Action**: Implement Priority 1-5 fixes in CodexAgent to match ClaudeAgent's correct behavior.
