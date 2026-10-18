# NemoDots: 45-second demo script

Setup before recording: follow `DEMO-QUICK.md` so the server and the UI are running, then open `http://127.0.0.1:5180/#/missions`. Do a dry run first, and keep the finished mission open in a second tab as a fallback.

| Time | Say (voiceover) | Show on screen |
| --- | --- | --- |
| 0:00–0:08 | **Problem.** AI agents now fix production systems. They also act on stale facts: an agent reads a value, the world changes, and it ships a fix for a world that no longer exists. In ops, that turns into an outage. | The checkout health panel showing **degraded** and `cache_decode_error`. |
| 0:08–0:16 | **Solution.** NemoDots is a team of NVIDIA Nemotron agents that restores a broken service. Every fact it acts on is a typed receipt in an evidence ledger. I give it one goal. | Type the goal "Restore checkout availability while preserving customer data", click **Create mission**, then **Run injector** (`dependent_change_after_proposal`), then **Start**. The **LIVE** badge shows `api.inference.crusoecloud.com` and Nemotron 3 Super. |
| 0:16–0:26 | The planner splits the goal into branches. An investigator finds the cache schema fault and delegates to a cache specialist, which spawns its own verifier. Every observation lands in the ledger live. | The **Task tree** grows: planner → 2 investigators → cache_specialist → verifier. The **Evidence ledger** fills with receipts. |
| 0:26–0:36 | **The key moment.** The specialist proposes a config fix, and the config changes underneath it. NemoDots re-checks the version under a database row lock, in the same transaction as the write. It blocks the fix as `stale_version`. Only that branch re-reads and repairs; the customer-data branch makes no new model calls. | **Action inspector**: the first action shows **blocked · stale_version** ("bound to vN, live vN+1"), and the second shows **committed**. **Recovery timeline**: receipt registered → action blocked → repair attempt on the specialist only. |
| 0:36–0:45 | The corrected fix commits. An independent probe places a fresh order, reads it back and checks inventory. Mission succeeded, with no stale action and no lost customer data. **Sponsors:** Nemotron reasoning on Crusoe Managed Inference; the UI is CopilotKit OpenDots. | **Acceptance/probe** panel shows **pass**, and the mission status pill shows **Succeeded**. End on the full page. |

## Sponsors (one line each)

- **Crusoe Managed Inference** runs every planner, investigator, specialist and verifier call live (`api.inference.crusoecloud.com`, at most 2 in flight). The telemetry panel shows calls and tokens.
- **NVIDIA Nemotron 3 Super** (`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`) does the planning, typed tool calls, recursive delegation and remediation proposals. Nothing in the plan is scripted.
- **CopilotKit OpenDots** is the app shell and UI that NemoDots is built on. Intelligence is configured, and it powers the upstream conversation features.

## One-liner for judges

"Agents that act on evidence should refuse to act on stale evidence. NemoDots makes that a database guarantee rather than a prompt."
