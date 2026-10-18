# Remediation policy

- Only two bounded actions exist: `set_config` (one key, one value) and `flush_cache_namespace` (delete cached catalog blobs in one namespace). Customer data (orders, inventory) is never modified by remediation.
- Before proposing, re-observe the exact key you will change. The server binds the proposal to the version you observed; if the key changes before commit, the action is blocked (`stale_version`) and you must re-observe and decide again.
- Change as little as possible: do not touch keys unrelated to the diagnosed fault.
- After a committed action, an independent verifier must confirm health from live sources. Acceptance is decided by an independent probe (fresh order create/read, inventory invariant, health window), not by agents.
