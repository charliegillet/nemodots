# NemoDots: 25-second demo (completed run)

Open a finished mission at `http://127.0.0.1:5180/#/missions/<id>` (see `DEMO-QUICK.md`), then scroll down the page while you talk.

| Time | Say | Show |
| --- | --- | --- |
| 0–6 s | AI agents now fix production, and they act on stale facts: the world changes and they ship the wrong fix. | Header: **Succeeded**, **LIVE**, `api.inference.crusoecloud.com`, Nemotron 3 Super. |
| 6–13 s | NemoDots is a team of Nemotron agents on Crusoe. From one goal they planned, delegated down to a cache specialist and a verifier, and logged every fact as a receipt. | **Task tree** (planner → investigator → cache specialist → verifier) and the **Evidence ledger**. |
| 13–21 s | The config changed under the specialist's fix. A row-locked version check blocked it as `stale_version`, and only that branch repaired. | **Action inspector**: `set_config` **blocked · stale_version** ("bound to v42, live v43"), then the corrected action **verified**. **Recovery timeline**. |
| 21–25 s | The fix landed and an independent order probe passed. Built on CopilotKit OpenDots. | **Probe: pass** and **Succeeded**. |

**Sponsors:** Crusoe Managed Inference serves every agent call. NVIDIA Nemotron 3 Super does all of the planning, tool calls and fixes. CopilotKit OpenDots is the app and UI.
