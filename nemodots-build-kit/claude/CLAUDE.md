# NemoDots engineering contract

Build NemoDots from this OpenDots checkout. Read `docs/nemodots/BUILD_PROMPT.md`, `TEST_PROMPT.md`, `SANDBOX_SPEC.md` and `SOURCES.md` before implementation. These describe the requested product; generated setup assets do not mean it has been built.

- Development lead and critical reviewers: `claude-opus-5`. Implementers and dependency auditor: `claude-sonnet-5-5`. Verify effective models; no silent substitutions.
- Finished app reasoning: NVIDIA Nemotron served by Crusoe. Claude models are build-time only.
- Use Node >=24 and npm; `npm ci`, `npm run dev`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Preserve package-lock and upstream licenses.
- Conversations require CopilotKit Intelligence separately from the Crusoe key. `.env` stays private. No keys in VITE variables, logs, bundles or reports.
- PostgreSQL owns typed operational state; SQLite owns existing workspace pages. Authoritative configuration targets and relevant source versions share one PostgreSQL transaction boundary. Redis/network adoption is eventual.
- Runtime-stamp complete scoped readsets; validate current support at publication, reuse, delegation and controlled commit. Pages and LLM assertions cannot grant authority.
- Keep one writer per file. Freeze reviewed contracts and independent acceptance before builders work. Staged native teams if available; otherwise label persistent subagents honestly.
- Reviewers cannot weaken tests to pass. Verify actual backend state and the integrated revision/diff; old logs are insufficient.
- Preserve original permissions and approvals. Cover all enabled tool paths; unknown write paths stay disabled in the incident scope.
- Implement, run, inspect, repair and verify. Do not stop at plans or claim fixtures are live proof. Report PASS/FAIL/BLOCKED/NOT_RUN explicitly.
- Do not push to upstream, publish/deploy or send external messages as part of this assignment. Existing repository/user instructions still apply.
