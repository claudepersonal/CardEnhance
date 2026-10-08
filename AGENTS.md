# Repository Guidelines

## Project Structure & Module Organization

CardEnhance is a TypeScript/Vite web app for sports-card detection, OCR,
restoration, and export. UI code is in `src/`; server and database code is in
`server/` and `migrations/`; automation lives in `scripts/`. Keep ML assets
under `models/`, public files under `public/`, and generated run data under
`data/runs/`. Do not commit `.env*`, `data/secrets.json`, model downloads, or
generated build output.

## Build, Test, and Development Commands

Use the committed npm lockfile:

```sh
npm ci                 # install locked dependencies
npm run dev            # run Vite on port 8080
npm run typecheck      # TypeScript check without emitting files
npm test               # run Node script tests
npm run lint           # run ESLint
npm run build          # production build and database migrations
```

Run the focused test first, then `npm run typecheck`, `npm test`, and
`npm run lint` before handing off a change. Record blocked browser, OCR, model,
or database checks rather than treating a successful build as full validation.

## Coding Style & Naming Conventions

Use TypeScript, two-space indentation, and the repository's Prettier and ESLint
configuration. Prefer small functions, explicit input validation, and early
returns. Use descriptive `camelCase` for variables and functions, `PascalCase`
for React components, and kebab-case for route and asset filenames. Do not edit
generated files or migration history by hand unless the task specifically
requires it.

## Testing, Commits, and Pull Requests

Add or update a `scripts/*.test.mjs` test for behavior changed in scripts. For
UI or API changes, include the relevant typecheck/lint/test results and a
screenshot or request/response evidence when applicable. Recent history uses
short conventional messages such as `fix: ...` and `feat: ...`; follow that
style. Keep commits focused. Pull requests should explain the user-facing
change, validation performed, required secrets or migrations, and remaining
limitations.

## Secrets and Coordination

Use the connected 1Password Developer Environment `AI` as the approved secret
source for Codex tasks (including `OPENAI_API_KEY`). Keep runtime values such
as database URLs and auth secrets in approved environment settings or
1Password; never place values in source, logs, or pull requests.

## Codex task-boundary board

- This repository uses the opt-in Codex task-boundary board in `.codex/coordination/project.yaml`.
- Before substantial writes, load the installed `codex-coordinator` skill, list active claims from the primary worktree, and publish only this task's bounded claim.
- Native Codex tasks remain the execution, messaging, and transcript authority; an explicitly requested goal Coordinator is on demand, with no heartbeat or mandatory pull-request workflow.
- Reject cross-project notices and never store transcripts, reasoning, prompts, or tool output in Coordinator state.
