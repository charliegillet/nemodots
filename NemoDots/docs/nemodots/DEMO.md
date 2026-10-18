# NemoDots demo guide

This guide describes the changed-evidence demonstration: what to set up, what happens, how to read it, and what it does and does not prove. It contains no measured results. Every result below is a placeholder marked **NOT_RUN** until the evaluation wave (W6) fills it in from exported run files.

**State of the build when this was written:** the mission routes, coordinator, ledger, action boundary, watcher, telemetry and mission screen exist and are tested separately, but the bootstrap that wires them into the running server (W5.1) is not done, so the demo below cannot yet be run end to end through the app. See `SETUP.md` section 9. Treat the steps as the intended procedure, not as a recording.

## 1. What the demo shows

The goal given to the team is **restore checkout availability while preserving customer data**. A Nemotron planner (through Crusoe) splits it into tasks; workers read real sources (checkout health and metrics, Redis stats, configuration), delegate narrower child tasks within depth and capability limits, and publish findings. Some workers can propose a bounded configuration change. Every proposal carries the evidence it rests on.

While a proposal is waiting, one of the controlled configuration values it depended on changes. The point of the demo is what happens next:

1. The change advances the source's version under the same version authority every controlled write uses.
2. The source watcher reads the new state and registers a new receipt; the old receipt becomes superseded.
3. Everything that rested on the old receipt is invalidated: tasks, outputs, findings and proposed actions that depend on it, found by walking recorded evidence and inheritance edges (not by asking a model).
4. A queued action built on the old receipt cannot commit; either it is blocked, or it committed first and the next invalidation is repaired (section 5).
5. Affected tasks get repair attempts that start from fresh reads and a short invalidation summary, not the old transcript.
6. A branch whose evidence never touched the changed source is left alone, with no new model calls.
7. An independent probe, not a model, decides whether checkout is actually restored.

## 2. Honest limits to say out loud

- **The dependent change is scenario-driven.** A private injector applies the change on a schedule or when it sees a proposal for a given key. It is a test device for reproducibility. It does not tell the agents what changed or what to do; they find it through the watcher and receipts. Do not present it as a spontaneous production event.
- **Controlled configuration is under a strong guarantee; observed sources are not.** For the supported controlled configuration keys, the version authority and the commit share one PostgreSQL transaction, so a commit checks the whole version vector atomically. For observed sources (health, metrics, Redis stats) the guarantee is **freshness at admission**: the evidence was current when the action was admitted, and a change a moment later can still arrive. The demo labels this in the action inspector.
- **Redis flush is an external effect.** It is dispatched with a fenced script, read back and reconciled; if the outcome cannot be established it is shown as `outcome_unknown`, not as success.
- **Receipt lineage is conservative provenance, not proof of semantic causality.** It can over-invalidate; it should not under-invalidate for recorded reads. Anything the agents never recorded reading is outside it.
- **Fixture and live are different things.** The mission header shows a Fixture or Live badge, and every model call is stamped. Fixture mode replays recorded provider responses; it proves plumbing and determinism, not reasoning. A scripted adapter policy is used for deterministic race proofs and is labelled as such, separately from live trials.
- A bounded set of configuration keys and two actions (set a configuration value, flush a cache namespace) are supported. Unknown write paths stay disabled.

## 3. Before you start

Follow `SETUP.md`: stack started, migrated and seeded, environment set (three `OPENAI_*` names, Intelligence key only if you also want OpenDots chat), server running with the NemoDots bootstrap (**not available yet**). Check:

| Check                                          | Expected                                                                                   | Status                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `curl http://127.0.0.1:<checkout port>/health` | `{"status":"ok",...}` with all checks true                                                 | PASS on the throwaway instance (see `SETUP.md`) |
| `GET /api/nemodots/health`                     | mode `live`, postgres/redis `ok`, checkout reachable, provider host from `OPENAI_BASE_URL` | NOT_RUN: route not mounted until W5.1           |
| Open `#/missions` in the app                   | the mission list and create form                                                           | NOT_RUN                                         |

## 4. Procedure

1. **Create the mission.** In the create form enter the goal above. Set the **admission delay** (`admission.minAgeMs`, 0 to 60000 ms) to about 3000. Admission of a proposed action waits at least that long, which gives the scenario-driven change time to land first. With 0 the race is much tighter and either outcome can occur. Choose live mode only if the Crusoe variables are set; the server decides the mode and refuses a different one.
2. **Start the mission.** The planner produces a task tree; the Task tree view shows roles, status and delegation depth. Open the Evidence ledger to see receipts as workers read sources.
3. **Let investigation branches run.** There are at least two independent branches (for example cache and database evidence). Findings appear with the receipts they cite. Findings are model claims; the ledger entries are the evidence.
4. **Trigger the changed evidence.** In the Acceptance console use **Injector run** with the scenario class for a dependent change after a proposal (the repository ships manifests such as `dependent_change_after_proposal`, `second_change_during_repair`, `diverging_edges`, `benign_change` and single-fault scenarios; whether a name maps one-to-one to a manifest file is **NOT_RUN** until bootstrap wires the injector). The console shows only a run id; it never shows the schedule or the injected value. As a manual alternative use **Manual source edit** on a controlled key with its current version; that goes through the same version authority and is rejected with a conflict if the version is stale.
5. **Watch recovery.** The Recovery timeline and the Evidence ledger update from the event stream. Reconnect or reload and the view rebuilds from the stored snapshot and replays missed events.
6. **Read the outcome** (section 5), then read the Acceptance probe panel in the Acceptance console (section 6); the probe is run by the coordinator when the mission reaches acceptance, not by a button.
7. **Read telemetry** (section 7).

## 5. Reading the recovery timeline and the action inspector

Open the Action inspector for the proposed action. It lists the authorization stages (admission, commit, dispatch) with the decision, the dependency vector that was checked and, when blocked, the reason.

The honest outcome is one of two, and the demo records which happened:

| Outcome                      | What you see                                                                                                                                                                        | What it means                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocked before commit**    | The action stage shows a block with reason `stale_version` (or another named reason); the timeline shows the invalidation, then repair attempts for the affected tasks.             | The old evidence was superseded before the change committed, so nothing changed. This is the case the guarantee covers.                   |
| **Committed, then repaired** | The action committed with its checked vector; afterwards a second invalidation (for example the configuration moved again) appears, followed by repair attempts and a new proposal. | The action was valid when it committed. A later change is a new fact; the system repairs forward. It is not hidden or counted as a block. |

Either is acceptable. Reporting only the first when the second occurred would be wrong. The preserved branch appears in the timeline as unaffected; the expected preserved set is computed from recorded readsets and edges, and if that set is empty for a run the result is reported as not met rather than forced.

## 6. What the acceptance probe proves

The probe runs under its own database role and secret, outside the agents' reach. It creates a tagged order, reads it back, checks inventory and order invariants, and watches checkout health for a short window (`NEMODOTS_PROBE_WINDOW_MS`, default 20000 ms). A mission can only reach `succeeded` when a supported probe receipt says pass **and** no invalidation is still open.

It proves that, at probe time, checkout served a fresh order and the checked invariants held. It does not prove the cause was understood, that nothing else is wrong, or that the repair was the minimal one. A model saying "fixed" counts for nothing.

## 7. Telemetry

The telemetry panel shows calls, tokens, retries, errors and time to first token from stored provider attempts. **Unavailable is shown as unavailable, never as zero:** cached-token counts are present only if the provider reported them, orphaned calls (a lease lost while a request was in flight) are counted separately, and cost is shown only when the provider's `/v1/models` response supplies prices (its unit is not stated; it is read as USD per million tokens and labelled so). No savings are computed unless both sides of a comparison are known.

## 8. Results

Nothing below has been measured. Do not quote it.

| Item                                                                              | Result  |
| --------------------------------------------------------------------------------- | ------- |
| Healthy mission end to end (live)                                                 | NOT_RUN |
| Changed-evidence run: outcome (blocked before commit / committed then repaired)   | NOT_RUN |
| Preserved branch: zero new model calls                                            | NOT_RUN |
| Independent probe verdict after repair                                            | NOT_RUN |
| Comparison against broad restart and dependent-task restart (cohort, uncertainty) | NOT_RUN |
| Prefix reuse / cached tokens on Crusoe for this workload                          | NOT_RUN |

When W6 runs, replace each row with the run id, the exported file under `artifacts/` and the commit it was produced from.
