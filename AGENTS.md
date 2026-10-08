# Repository Guidelines

## Project Structure & Module Organization

CardEnhance is a TypeScript/Vite web app for sports-card detection, OCR,
restoration, and export. UI code is in `src/`; server/database code is in
`server/` and `migrations/`; automation is in `scripts/`. Keep ML assets in
`models/`, public files in `public/`, and generated runs in `data/runs/`. Do
not commit `.env*`, `data/secrets.json`, model downloads, or build output.

## Build, Test, and Development Commands

Use Node.js 22 or newer and the committed npm lockfile:

```sh
npm ci                 # install locked dependencies
npm run dev            # run Vite on port 8080
npm run typecheck      # TypeScript check without emitting files
npm test               # run Node script tests
npm run lint           # run ESLint
npm run build          # production build and database migrations
```

Run `npm run typecheck`, `npm test`, and `npm run lint` before handoff. Record
blocked browser, OCR, model, or database checks; a build is not full validation.

## Coding Style & Naming Conventions

Use TypeScript, two-space indentation, Prettier, and ESLint. Prefer small
functions, explicit validation, and early returns. Use `camelCase` for
variables/functions, `PascalCase` for React components, and kebab-case for
route and asset names. Do not hand-edit generated files or migration history.

## Testing, Commits, and Pull Requests

Add or update `scripts/*.test.mjs` tests for changed script behavior. For UI or
API work, include check results plus screenshot or request/response evidence.
Use short conventional commits such as `fix: ...` and `feat: ...`. Pull
requests explain the change, validation, required secrets/migrations, and limits.

## Secrets and Coordination

The cloud Codex job targets the dedicated 1Password `CardEnhance Codex`
Environment. Add only `OPENAI_API_KEY` there; its Workload Identity must be
connected before dispatch. On Windows, authenticate the local CLI separately:

```powershell
op signin
$env:OPENAI_API_KEY = 'op://<vault>/<item>/<field>'
op run -- codex.exe
```

Use a 1Password secret reference, never a plaintext key. `op run` does not
create GitHub Workload Identity. Keep secrets out of source, logs, and PRs.

## Codex task-boundary board

- This repository uses the opt-in Codex task-boundary board in `.codex/coordination/project.yaml`.
- Before substantial writes, load the installed `codex-coordinator` skill, list active claims from the primary worktree, and publish only this task's bounded claim.
- Native Codex tasks remain the execution, messaging, and transcript authority; an explicitly requested goal Coordinator is on demand, with no heartbeat or mandatory pull-request workflow.
- Reject cross-project notices and never store transcripts, reasoning, prompts, or tool output in Coordinator state.
