# Phase 1 Architecture

## System Overview

```mermaid
graph TB
    subgraph "Main Process"
        SDK[Claude SDK<br/>Agent Teams]
        TM[AgentTeamManager]
        IPC_EMIT[IPC Event Emitter]
    end

    subgraph "Core Types Package"
        VS[team-view-state.ts<br/>Dashboard State Types]
        EV[team-events.ts<br/>Event Envelopes]
    end

    subgraph "Renderer Process"
        HOOKS[React Hooks]
        DASH[useTeamDashboard<br/>State Management]
        EVENTS[useTeamEvents<br/>Event Subscription]
        UI[Dashboard Components<br/>TeamDashboard.tsx]
    end

    SDK -->|team activity| TM
    TM -->|create events| IPC_EMIT
    IPC_EMIT -->|team:event channel| EVENTS

    VS -.->|types| DASH
    EV -.->|types| EVENTS

    EVENTS -->|on/off handlers| HOOKS
    DASH -->|state + actions| UI
    HOOKS -->|callbacks| DASH
```

## Data Flow: Event Emission to UI Update

```mermaid
sequenceDiagram
    participant SDK as Claude SDK
    participant Main as Main Process
    participant IPC as IPC Channel
    participant Hook as useTeamEvents
    participant State as useTeamDashboard
    participant UI as Dashboard UI

    SDK->>Main: Teammate spawned via Task tool
    Main->>Main: Detect team_name parameter
    Main->>Main: Create TeammateSpawnedEvent
    Main->>IPC: emit('team:event', event)
    IPC->>Hook: Receive event
    Hook->>Hook: Filter by teamId
    Hook->>Hook: Dispatch to handlers
    Hook->>State: Trigger onTeammateSpawned callback
    State->>State: Dispatch UPDATE_TEAMMATE action
    State->>State: Update state.teammates.items
    State->>UI: Re-render with new state
    UI->>UI: Show new teammate in sidebar
```

## State Management Architecture

```mermaid
graph LR
    subgraph "useTeamDashboard Hook"
        INIT[Initial State<br/>createInitialDashboardState]
        REDUCER[Dashboard Reducer<br/>dashboardReducer]
        STATE[TeamDashboardViewState]
        ACTIONS[Action Dispatchers]
        DERIVED[Derived Metrics<br/>useMemo]
    end

    subgraph "Actions"
        NAV[Navigation<br/>SET_ACTIVE_PANEL]
        DATA[Data Updates<br/>UPDATE_TASK, UPDATE_TEAMMATE]
        FILTER[Filters<br/>UPDATE_TASK_FILTER]
        UI_ACT[UI State<br/>TOGGLE_SIDEBAR]
    end

    INIT -->|initial| STATE
    ACTIONS -->|dispatch| REDUCER
    NAV -->|action| REDUCER
    DATA -->|action| REDUCER
    FILTER -->|action| REDUCER
    UI_ACT -->|action| REDUCER
    REDUCER -->|new state| STATE
    STATE -->|compute| DERIVED
```

## Event Subscription Flow

```mermaid
graph TB
    subgraph "useTeamEvents Hook"
        SUB[Subscribe to teamId]
        IPC_ON[IPC Listener:<br/>team:event]
        FILTER[Filter Events<br/>teamId + eventTypes]
        BATCH{Batching<br/>Enabled?}
        QUEUE[Batch Queue]
        TIMER[Batch Timer<br/>100ms]
        DISPATCH[Dispatch Event]
        HANDLERS[Event Handlers<br/>Map by type]
    end

    SUB -->|mount| IPC_ON
    IPC_ON -->|receive| FILTER
    FILTER -->|match| BATCH
    BATCH -->|yes| QUEUE
    BATCH -->|no| DISPATCH
    QUEUE -->|wait| TIMER
    TIMER -->|flush| DISPATCH
    DISPATCH -->|emit| HANDLERS
    HANDLERS -->|callback| DISPATCH
```

## Mock Testing Architecture

```mermaid
graph LR
    subgraph "Test Environment"
        TEST[Test Code]
        MOCK_EMIT[MockTeamEventEmitter]
        HOOK_MOCK[useTeamEvents<br/>mock: true]
        COMP[Component Under Test]
    end

    subgraph "Production"
        HOOK_PROD[useTeamEvents<br/>mock: false]
        IPC_PROD[IPC Channel]
    end

    TEST -->|emit event| MOCK_EMIT
    MOCK_EMIT -->|dispatch| HOOK_MOCK
    HOOK_MOCK -->|state update| COMP

    style HOOK_PROD fill:#ddd
    style IPC_PROD fill:#ddd
```

## Type Dependency Graph

```mermaid
graph TB
    subgraph "Core Type Layer"
        AT[agent-teams.ts<br/>Base Team Types]
        VS[team-view-state.ts<br/>Dashboard State]
        EV[team-events.ts<br/>Event Envelopes]
    end

    subgraph "Hook Layer"
        DASH_HOOK[useTeamDashboard]
        EVENT_HOOK[useTeamEvents]
        SYNC_HOOK[useTeamStateSync]
    end

    subgraph "Component Layer"
        DASH_COMP[TeamDashboard]
        SIDEBAR[TeammateSidebar]
        DETAIL[TeammateDetailView]
    end

    AT -->|import| VS
    AT -->|import| EV
    VS -->|import| DASH_HOOK
    EV -->|import| EVENT_HOOK
    EVENT_HOOK -->|import| SYNC_HOOK

    DASH_HOOK -->|use| DASH_COMP
    EVENT_HOOK -->|use| DASH_COMP
    SYNC_HOOK -->|use| DASH_COMP
    DASH_HOOK -->|use| SIDEBAR
    DASH_HOOK -->|use| DETAIL
```

## Dashboard State Structure

```mermaid
graph TB
    ROOT[TeamDashboardViewState]

    ROOT -->|team| TEAM[AgentTeam]
    ROOT -->|activePanel| PANEL[DashboardPanel]
    ROOT -->|selectedTeammate| SEL[AgentTeammate]
    ROOT -->|tasks| TASKS[TaskState]
    ROOT -->|teammates| MATES[TeammateState]
    ROOT -->|activity| ACT[ActivityState]
    ROOT -->|messages| MSG[MessageState]
    ROOT -->|costs| COST[CostState]
    ROOT -->|ui| UI[UIState]
    ROOT -->|realtime| RT[RealtimeState]

    TASKS -->|items| TASK_ARR[TeamTask[]]
    TASKS -->|filter| FILTER[TaskFilter]
    TASKS -->|expanded| EXP[Set string]

    MATES -->|items| MATE_ARR[AgentTeammate[]]
    MATES -->|sortBy| SORT[SortOrder]

    ACT -->|events| EVENT_ARR[TeamActivityEvent[]]
    ACT -->|filter| ACT_FILTER[ActivityFilter]
    ACT -->|autoScroll| SCROLL[boolean]

    MSG -->|items| MSG_ARR[TeammateMessage[]]
    MSG -->|threads| THREADS[Map]

    COST -->|summary| SUMMARY[TeamCostSummary]
    COST -->|expanded| COST_EXP[boolean]

    UI -->|sidebarCollapsed| SB[boolean]
    UI -->|detailPanelVisible| DP[boolean]
    UI -->|loading| LOAD[boolean]
    UI -->|error| ERR[string]

    RT -->|connected| CONN[boolean]
    RT -->|lastUpdate| LAST[timestamp]
    RT -->|pendingUpdates| PEND[number]
```

## Event Type Hierarchy

```mermaid
graph TB
    BASE[TeamEventEnvelope T<br/>type, teamId, payload, timestamp]

    BASE -->|extends| LIFECYCLE[Team Lifecycle Events]
    BASE -->|extends| MATE[Teammate Events]
    BASE -->|extends| TASK[Task Events]
    BASE -->|extends| MESSAGE[Message Events]
    BASE -->|extends| OTHER[Activity/Cost/Error Events]

    LIFECYCLE -->|team:initialized| INIT
    LIFECYCLE -->|team:updated| UPD
    LIFECYCLE -->|team:cleanup| CLEAN
    LIFECYCLE -->|team:completed| COMP

    MATE -->|teammate:spawned| SPAWN
    MATE -->|teammate:updated| M_UPD
    MATE -->|teammate:delta| DELTA
    MATE -->|teammate:shutdown| SHUT

    TASK -->|task:created| T_CREATE
    TASK -->|task:updated| T_UPD
    TASK -->|task:claimed| CLAIM
    TASK -->|task:completed| T_COMP

    MESSAGE -->|message:sent| SENT
    MESSAGE -->|message:broadcast| BROAD

    OTHER -->|activity:logged| ACT_LOG
    OTHER -->|cost:updated| COST_UPD
    OTHER -->|cost:warning| WARN
    OTHER -->|team:error| ERROR
```

## Integration Points for Phase 2

```mermaid
graph LR
    subgraph "Phase 1: Complete"
        TYPES[Core Types ✓]
        HOOKS[React Hooks ✓]
    end

    subgraph "Phase 2: Next"
        DETECT[Tool Detection<br/>craft-agent.ts]
        SESSION[Session Manager<br/>sessions.ts]
        IPC_HAND[IPC Handlers<br/>team.ts]
        COMP[UI Components<br/>TeamDashboard.tsx]
    end

    TYPES -.->|use| DETECT
    TYPES -.->|use| SESSION
    TYPES -.->|use| IPC_HAND
    HOOKS -.->|use| COMP

    DETECT -->|emit events| IPC_HAND
    SESSION -->|track state| IPC_HAND
    IPC_HAND -->|send to renderer| COMP
    COMP -->|consume hooks| HOOKS
```

## Real-Time Update Pipeline

```mermaid
graph LR
    subgraph "Event Source"
        SDK_TOOL[SDK Tool Call:<br/>Task with team_name]
        FILE_WATCH[File Watcher:<br/>~/.claude/teams/]
        AGENT_MGR[AgentTeamManager]
    end

    subgraph "Event Creation"
        FACTORY[createTeamEvent]
        ENVELOPE[TeamEventEnvelope]
    end

    subgraph "Transport"
        IPC_SEND[mainWindow.send<br/>team:event]
        IPC_RECV[ipcRenderer.on<br/>team:event]
    end

    subgraph "Consumption"
        HOOK_SUB[useTeamEvents<br/>subscription]
        HOOK_BATCH[Event Batching]
        HANDLER[Event Handler]
        STATE_UPDATE[State Dispatch]
    end

    SDK_TOOL -->|detect| AGENT_MGR
    FILE_WATCH -->|detect| AGENT_MGR
    AGENT_MGR -->|create| FACTORY
    FACTORY -->|envelope| ENVELOPE
    ENVELOPE -->|emit| IPC_SEND
    IPC_SEND -->|channel| IPC_RECV
    IPC_RECV -->|subscribe| HOOK_SUB
    HOOK_SUB -->|queue| HOOK_BATCH
    HOOK_BATCH -->|dispatch| HANDLER
    HANDLER -->|trigger| STATE_UPDATE
```

## Performance Characteristics

### Event Batching Benefits

```mermaid
graph LR
    subgraph "Without Batching"
        E1[Event 1] -->|React update| R1[Render 1]
        E2[Event 2] -->|React update| R2[Render 2]
        E3[Event 3] -->|React update| R3[Render 3]
        E4[Event 4] -->|React update| R4[Render 4]
    end

    subgraph "With Batching 100ms"
        EB1[Event 1] -->|queue| BATCH
        EB2[Event 2] -->|queue| BATCH
        EB3[Event 3] -->|queue| BATCH
        EB4[Event 4] -->|queue| BATCH[Batch Queue]
        BATCH -->|flush| RB[Single Render]
    end
```

**Result:** ~75% reduction in render cycles for burst activity

### Memory Usage Pattern

- **Dashboard State:** ~50KB base + ~5KB per teammate + ~1KB per task
- **Event Queue:** ~2KB per event × batch size (typically 10-50 events)
- **Message Threads:** ~3KB per conversation thread

**Example:** Team of 5 teammates, 20 tasks, 100 activity events = ~200KB total state
