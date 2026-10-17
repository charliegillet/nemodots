[![Zylos Logo](https://zylos.ai/zylos-logo.png)Zylos](https://zylos.ai/) [Features](https://zylos.ai/#features) [Research](https://zylos.ai/research/) [Docs](https://zylos.ai/docs/)

EN [中](https://zylos.ai/zh/research/2026-03-17-crdts-distributed-state-sync-multi-agent-systems/)

[![Coco](https://zylos.ai/coco-logo.png)](https://coco.xyz/)

[Back to Notes](https://zylos.ai/research/)

2026-03-17

# CRDTs and Distributed State Synchronization for Multi-Agent AI Systems

crdtdistributed-systemsmulti-agentstate-synchronizationlocal-firsteventual-consistency

## Executive Summary

Multi-agent AI systems face a fundamental distributed systems problem: multiple agents operating concurrently need shared, mutable state — task assignments, knowledge bases, conversation history — and they cannot always synchronize through a central coordinator. Conflict-free Replicated Data Types (CRDTs) offer a mathematically proven solution: data structures where any replica can be updated independently, with automatic conflict resolution guaranteeing all replicas converge to identical state. This article examines CRDT fundamentals, their application to agent coordination, practical implementation libraries, and emerging patterns combining CRDTs with LLMs for semantic conflict resolution.

## The Coordination Problem

When multiple AI agents share state — a task board, a knowledge graph, a collaborative document — concurrent writes create conflicts. Traditional solutions fall into two camps:

**Centralized coordination** (Redis, Postgres, a central API) works when all agents can reliably reach the server with acceptable latency. It fails when the server is unavailable and offers no offline-write capability.

**Consensus protocols** (Raft, Paxos) enforce strong consistency: every write waits for quorum acknowledgment. This sacrifices availability during network partitions — a write cannot succeed without quorum.

CRDTs take a third path. As Kleisli.IO's 2025 analysis argues, multi-agent workflows exhibit "private state, independent failure modes, and shared mutable resources" — precisely what distributed systems theory addresses. Agent coordination should leverage proven distributed systems primitives, not reinvent them as AI-specific abstractions.

## CRDT Fundamentals

CRDTs, formally defined in 2011 by Shapiro et al., are data structures that guarantee **Strong Eventual Consistency (SEC)**: all replicas receiving the same set of updates converge to identical state, regardless of delivery order.

Two primary flavors exist:

- **State-based (CvRDTs):** Replicas broadcast full state; recipients merge using a deterministic `merge()` function satisfying lattice properties (commutativity, associativity, idempotence). Simple but bandwidth-heavy.
- **Operation-based (CmRDTs):** Replicas broadcast individual operations that must be commutative. Bandwidth-efficient but requires causal delivery guarantees from the network layer.
- **Delta-state (hybrid):** Broadcast only the diff since last sync — operation-sized bandwidth with state-based simplicity. Most modern implementations (Automerge 2.x, Riak) use this approach.

## CRDT Types for Agent Systems

Different agent coordination patterns map to specific CRDT types:

| CRDT Type | Behavior | Agent Use Case |
| --- | --- | --- |
| **G-Counter** | Increment-only; merge = max per replica | Token usage tracking, action counting |
| **PN-Counter** | Two G-Counters (pos/neg); supports decrement | Priority weights, resource budgets |
| **G-Set** | Set union; elements never removed | Append-only observation logs, completed task IDs |
| **OR-Set** | Tagged elements; concurrent adds survive removes | Shared task queues, artifact registries |
| **LWW-Register** | Last-write-wins by timestamp | Task status, ownership, configuration |
| **MV-Register** | Returns all concurrent values for app resolution | When data loss is unacceptable |
| **RGA** | Ordered list with causal insertion IDs | Collaborative plans, conversation history |
| **JSON CRDTs** | Nested map/list/register composites | Full agent state objects |

**OR-Set semantics deserve special attention for agents.** If agent A adds task T while agent B concurrently removes it (based on an older snapshot), the OR-Set preserves the add — "add wins." This matches expected behavior in most agent scenarios where lost work is more harmful than stale state.

## Comparison with Alternatives

**CRDTs vs. Operational Transformation (OT):** OT requires a central authority to impose total ordering on operations, creating a bottleneck incompatible with decentralized architectures. OT algorithms are also notoriously difficult to implement correctly. CRDTs embed conflict resolution into the data structure itself, eliminating coordination requirements.

**CRDTs vs. Event Sourcing:** These are complementary, not competing. The production system "kli" demonstrates the combination: event sourcing as the durable log, CRDTs as the merge function for computing current state. Event sourcing enables time travel and audit trails; CRDTs handle concurrent multi-writer convergence.

**CRDTs vs. Consensus (Raft/Paxos):** Consensus protocols sacrifice availability during partitions. CRDTs sacrifice strong consistency for always-writable local state. Use consensus for exclusive resources (financial ledgers, leader election); use CRDTs for collaborative state where concurrent writes should both survive.

## Agent-Specific Patterns

### Shared Task Queues

Model the queue as an OR-Set with per-task CRDT fields:

```
task_queue: OR-Set<Task>
task.status: LWW-Register<"pending" | "claimed" | "done">
task.claimed_by: LWW-Register<AgentID | null>
task.observations: G-Set<Observation>
task.artifacts: OR-Set<Artifact>
task.priority: PN-Counter
```

Concurrent claims produce two tags, resolved by a higher-level priority rule or timeout. Additions by any agent are preserved; status updates converge via LWW.

### Distributed Knowledge Graphs

Use OR-Map for key-value facts and G-Set for established facts that should never be retracted. For conflicting fact values, MV-Register surfaces all concurrent values to an arbiter agent for semantic resolution rather than silently discarding one. Graph edges use OR-Set semantics — concurrent add/remove races default to "add wins," which matches knowledge accumulation goals.

### Eventually Consistent Agent State

Full agent state (goals, context, in-progress work) can be structured as a JSON CRDT document. Each agent holds a local replica. On network reconnect, delta-sync exchanges only the diff. For agent fleets, this enables gossip-style convergence without any central coordinator — agents synchronize peer-to-peer whenever they encounter each other.

## Implementation Landscape

### Automerge 2.0 + Repo 2.0

The most mature JSON CRDT library. Core rewritten in Rust with WASM compilation for JavaScript, ensuring identical logic across platforms. Repo 2.0 (May 2025) adds document collection management, automatic reconnection, resumable sync, and React integration. Best for production-grade JSON document collaboration.

### Yjs

The performance benchmark — consistently fastest in published benchmarks, with 900k+ weekly npm downloads. Deep editor integrations (Prosemirror, Tiptap, Monaco, CodeMirror). Best for real-time collaborative text editing where raw performance is critical.

### Diamond Types (Rust)

Benchmarked as "the world's fastest CRDT" — 5,000x faster than early Automerge using a range tree (B-tree variant) for O(log n) operations. Currently text-only; JSON support in development. Best for performance-critical Rust environments.

### Loro (Rust + WASM)

The newest entrant with the richest type system including **movable trees** — a rare CRDT type valuable for hierarchical state (task trees, document outlines). Implements Peritext for rich text with formatting. Still experimental; not yet recommended for production data.

### cr-sqlite

SQLite extension adding CRDT semantics to existing databases without schema changes. Columns configured as LWW, fractional index, or counter CRDTs. Runs everywhere SQLite runs (browser via WASM, edge, mobile, server). Best for teams already on SQLite who want CRDT-powered sync.

## Challenges and Limitations

### Tombstone Bloat

Sequence CRDTs and OR-Sets accumulate tombstones — deletion markers needed to prevent re-appearance during merge. In long-running agent systems processing many tasks, this overhead grows indefinitely. Garbage collection requires coordination: tombstones can only be purged once all replicas acknowledge the deletion, adding complexity and temporarily reducing availability.

### Semantic Conflicts

CRDTs guarantee _structural_ convergence but not _semantic_ correctness. The CodeCRDT paper (arXiv:2510.18893, EuroSys 2025) empirically measured this: 5–10% of concurrent code edits by LLM agents produced structurally valid but logically conflicting results after CRDT merge. Structural tools detect most conflicts, but logical ones require semantic analysis.

### Schema Evolution

CRDT documents must maintain backward and forward compatibility across agent versions. Cambria (integrated with Automerge) addresses this using bidirectional lenses that translate between schema versions, but schema evolution remains one of the least-solved problems in CRDT production deployments.

### Clock Synchronization

LWW-Register semantics depend on timestamps. In distributed systems, clocks drift. Hybrid Logical Clocks (HLC) are the practical compromise — combining physical time with logical counters to preserve causality without strict synchronization.

## Emerging Patterns

### LLMs as Semantic Arbiters

The most significant emerging pattern layers LLMs above structural CRDTs. CRDTs handle convergence mechanics; LLMs handle meaning. CodeCRDT operationalizes this: agents observe shared CRDT state, skip work already done by peers, and an LLM-driven arbiter resolves semantic conflicts the merge function cannot. This "observation-driven coordination" generalizes to any multi-agent system with shared structured memory.

### CRDT Databases Going Mainstream

cr-sqlite and Synql (INRIA, DAIS 2024) shift CRDTs from special-purpose libraries to database features. The convergence of SQLite's ubiquity with CRDT-powered sync produces a new category: databases with built-in multi-writer replication that don't require application-layer CRDT awareness.

### Edge and P2P Agent Networks

Research at ECOOP 2025 demonstrated CRDTs running on microcontrollers (ESP32, 520KB SRAM). FOSDEM 2026 hosted its first "Local First, sync engines and CRDTs" devroom. P2P CRDT architectures outperform centralized ones for low-latency scenarios — directly applicable to edge-deployed agent clusters that need local-first operation with eventual global consistency.

## Conclusion

CRDTs provide a mathematically grounded foundation for multi-agent state synchronization — one that doesn't require reinventing coordination as an AI-specific problem. The key insight is layered architecture: CRDTs handle structural convergence at the data layer, while LLMs provide semantic conflict resolution at the application layer. As agent systems move toward more distributed, autonomous operation, this combination of proven distributed systems primitives with AI-powered semantic understanding offers a robust path forward.

## References

- Shapiro et al., "Conflict-free Replicated Data Types" (2011) — foundational CRDT paper
- [CodeCRDT: Observation-Driven Coordination for Multi-Agent LLM Code Generation](https://arxiv.org/abs/2510.18893) (EuroSys 2025)
- [Agent Coordination Is a Distributed Systems Problem](https://blog.kleisli.io/post/agent-coordination-distributed-systems) — Kleisli.IO (2025)
- [The CRDT Dictionary](https://www.iankduncan.com/engineering/2025-11-27-crdt-dictionary/) — Ian Duncan (Nov 2025)
- [Automerge](https://automerge.org/) — JSON CRDT library and Repo 2.0
- [Yjs](https://docs.yjs.dev/) — high-performance CRDT framework
- [Diamond Types](https://github.com/josephg/diamond-types) — fastest text CRDT (Rust)
- [Loro](https://github.com/loro-dev/loro) — movable tree CRDTs (Rust + WASM)
- [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) — CRDT-powered SQLite
- [Synql: CRDT-Based Replicated Relational Databases](https://inria.hal.science/hal-04969158v3/document) (DAIS 2024)
- [CRDT.tech](https://crdt.tech/) — canonical resource and papers list