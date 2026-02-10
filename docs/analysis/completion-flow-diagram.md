# Agent Completion Flow Diagram

Visual representation of how completion gating works for agent teams (REQ-001, REQ-003).

## ClaudeAgent: Current (Correct) Flow

```mermaid
graph TD
    A[User sends message] --> B[Agent processes]
    B --> C{Task tool with<br/>team_name?}
    C -->|Yes| D[Set activeTeamName<br/>Increment activeTeammateCount]
    C -->|No| E[Normal processing]
    D --> F[Spawn teammate]
    F --> G[Return tool result]
    E --> G
    G --> H{Agent result message<br/>subtype=success}
    H --> I{Check team state:<br/>activeTeamName &&<br/>activeTeammateCount > 0?}
    I -->|Yes - Team Active| J[Emit usage_update]
    I -->|No - No Team| K[Emit complete]
    J --> L[Session stays alive<br/>Lead continues]
    K --> M[Session terminates]

    style I fill:#4CAF50,stroke:#2E7D32,stroke-width:3px,color:#fff
    style J fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style K fill:#FF9800,stroke:#E65100,stroke-width:2px,color:#fff
```

## CodexAgent: Current (Missing Gating) Flow

```mermaid
graph TD
    A[User sends message] --> B[Agent processes]
    B --> C{Task tool with<br/>team_name?}
    C -->|Yes| D[❌ No state tracking]
    C -->|No| E[Normal processing]
    D --> F[Spawn teammate]
    F --> G[Return tool result]
    E --> G
    G --> H[turn/completed event]
    H --> I[❌ Always emit complete<br/>No team check]
    I --> J[Session terminates]

    style D fill:#f44336,stroke:#c62828,stroke-width:3px,color:#fff
    style I fill:#f44336,stroke:#c62828,stroke-width:3px,color:#fff
    style J fill:#ff5722,stroke:#d84315,stroke-width:2px,color:#fff
```

## CodexAgent: Proposed (Fixed) Flow

```mermaid
graph TD
    A[User sends message] --> B[Agent processes]
    B --> C{Task tool with<br/>team_name?}
    C -->|Yes| D[✅ Set activeTeamName<br/>✅ Increment activeTeammateCount]
    C -->|No| E[Normal processing]
    D --> F[Spawn teammate]
    F --> G[Return tool result]
    E --> G
    G --> H[turn/completed event]
    H --> I{✅ Check team state:<br/>activeTeamName &&<br/>activeTeammateCount > 0?}
    I -->|Yes - Team Active| J[✅ Emit usage_update]
    I -->|No - No Team| K[✅ Emit complete]
    J --> L[Session stays alive<br/>Lead continues]
    K --> M[Session terminates]

    style D fill:#4CAF50,stroke:#2E7D32,stroke-width:3px,color:#fff
    style I fill:#4CAF50,stroke:#2E7D32,stroke-width:3px,color:#fff
    style J fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style K fill:#FF9800,stroke:#E65100,stroke-width:2px,color:#fff
```

## State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> NoTeam: Session starts
    NoTeam --> TeamActive: Task tool spawns<br/>first teammate<br/>(set activeTeamName,<br/>increment count)
    TeamActive --> TeamActive: Additional teammates<br/>spawned<br/>(increment count)
    TeamActive --> TeamCompleting: Teammate shuts down<br/>(decrement count)
    TeamCompleting --> TeamCompleting: More teammates<br/>shut down<br/>(decrement count)
    TeamCompleting --> NoTeam: Last teammate done<br/>(count reaches 0)
    NoTeam --> [*]: Emit complete<br/>Session terminates
    TeamActive --> TeamActive: Lead receives messages<br/>continues coordination

    note right of TeamActive
        activeTeamName = "team-123"
        activeTeammateCount = 2
        Emits: usage_update
    end note

    note right of NoTeam
        activeTeamName = null
        activeTeammateCount = 0
        Emits: complete
    end note
```

## Completion Decision Tree

```mermaid
graph TD
    A[Agent receives<br/>result message] --> B{subtype === 'success'?}
    B -->|No - Error| C[Emit error]
    C --> D[Emit complete<br/>Always complete on error]
    B -->|Yes - Success| E{activeTeamName<br/>is set?}
    E -->|No| F[❌ No team]
    F --> G[Emit complete<br/>Normal termination]
    E -->|Yes| H{activeTeammateCount<br/>> 0?}
    H -->|No| I[❌ Team exists but<br/>no teammates]
    I --> G
    H -->|Yes| J[✅ Team is active]
    J --> K[Emit usage_update<br/>Keep session alive]
    K --> L[Lead continues<br/>processing]

    style J fill:#4CAF50,stroke:#2E7D32,stroke-width:3px,color:#fff
    style K fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style F fill:#FF9800,stroke:#E65100,stroke-width:2px,color:#fff
    style I fill:#FF9800,stroke:#E65100,stroke-width:2px,color:#fff
    style G fill:#FF9800,stroke:#E65100,stroke-width:2px,color:#fff
```

## Multi-Agent Sequence

```mermaid
sequenceDiagram
    participant User
    participant Lead as Lead Agent
    participant T1 as Teammate 1
    participant T2 as Teammate 2

    User->>Lead: Send message
    Lead->>Lead: Process request
    Lead->>Lead: Task tool: spawn T1<br/>(activeTeammateCount = 1)
    Lead->>T1: Spawn session
    T1-->>Lead: Running
    Lead->>Lead: Task tool: spawn T2<br/>(activeTeammateCount = 2)
    Lead->>T2: Spawn session
    T2-->>Lead: Running
    Lead->>Lead: Success message received
    Lead->>Lead: Check: activeTeamName ✅<br/>activeTeammateCount = 2 ✅
    Lead->>User: ⬆️ usage_update (stay alive)

    Note over Lead,T2: Lead stays active, coordinates team

    T1->>Lead: Message: Task complete
    Lead->>Lead: Decrement count (= 1)
    T1->>Lead: Shutdown request
    Lead->>Lead: Decrement count (= 0)
    Lead->>Lead: Success message received
    Lead->>Lead: Check: activeTeammateCount = 0 ❌
    Lead->>User: ✅ complete (terminate)
```

## Edge Cases

```mermaid
graph LR
    A[Edge Cases] --> B[Team name set<br/>but count = 0]
    A --> C[Spawn fails<br/>count not incremented]
    A --> D[All teammates<br/>shut down early]
    A --> E[Lead processes<br/>multiple turns]

    B --> F[✅ Emit complete<br/>No active teammates]
    C --> F
    D --> F
    E --> G[✅ Each turn checks<br/>team state fresh]

    style A fill:#9C27B0,stroke:#6A1B9A,stroke-width:2px,color:#fff
    style F fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff
    style G fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff
```

## Implementation Locations

```mermaid
graph TD
    subgraph ClaudeAgent [ClaudeAgent ✅]
        CA1[Lines 403-406:<br/>State properties]
        CA2[Lines 920-927:<br/>Set state on spawn]
        CA3[Lines 2573-2589:<br/>Gate completion]
        CA1 --> CA2
        CA2 --> CA3
    end

    subgraph CodexAgent [CodexAgent ❌→✅]
        CO1[Lines 167-266:<br/>❌ No state properties<br/>✅ Add after line 211]
        CO2[Lines 1157-1192:<br/>❌ No state tracking<br/>✅ Add after line 1162]
        CO3[Lines 427-441:<br/>❌ No gating<br/>✅ Add team check]
        CO4[Lines 1933-1936:<br/>❌ No gating<br/>✅ Add team check]
        CO1 --> CO2
        CO2 --> CO3
        CO3 --> CO4
    end

    style CA1 fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff
    style CA2 fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff
    style CA3 fill:#4CAF50,stroke:#2E7D32,stroke-width:2px,color:#fff
    style CO1 fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style CO2 fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style CO3 fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
    style CO4 fill:#2196F3,stroke:#1565C0,stroke-width:2px,color:#fff
```

---

**Requirements Traceability**:
- REQ-001: Lead agent does not emit `complete` when team is active → Gating condition
- REQ-003: Lead agent emits `complete` normally when no team → Else branch

**Key Insight**: The gating condition `activeTeamName && activeTeammateCount > 0` is the critical check that differentiates team-aware completion from normal completion.
