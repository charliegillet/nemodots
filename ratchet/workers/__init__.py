"""Alternative worker hosts for Ratchet (owner I4).

`ratchet.workers.openbot_worker.OpenBotWorker` runs Ratchet tasks with CopilotKit OpenBot's shipped
`agent-bot` as the coworker brain (mode "agui"), or through a full OpenBot deployment (mode "stack",
which needs a CopilotKit Intelligence key). Import it lazily: `ratchet.cli` only imports this package
when `--worker openbot` is chosen. See `integrations/openbot/README.md`.
"""
