# AI scene evals

End-to-end evaluation of the scene chat (`/api/ai/chat`'s agent loop) against
real OpenAI, the real app catalog and the local store database. Each case is
one user request; the harness records what the agent did, lints the delivered
scene against the app catalog, renders it in the real FrameOS runtime
(frameos-wasm in a headless Chromium via the dev server), feeds runtime
errors back to the agent the way the editor's panel does, and finally grades
the result with deterministic checks plus a vision judge.

## Prerequisites

- The cloud dev server on `http://localhost:3000` (`pnpm dev` in `cloud/`) —
  it serves the wasm runtime and the same-origin HTTP proxy scenes fetch
  through. Override with `CLOUD_URL`.
- The local database holding the store scenes:
  `DATABASE_URL=… node scripts/import-store-scenes.mjs` mirrors every public
  scene of scenes.frameos.net (27 as of Aug 2026) into the dev database under
  the dev account, which the evals use (`EVAL_ACCOUNT_EMAIL`).
- `OPENAI_API_KEY` (read from `cloud/.env.local` when unset).

## Running

```
pnpm --filter @frameos-cloud/auth-web ai:eval                 # everything
pnpm --filter @frameos-cloud/auth-web ai:eval --filter modify # by tag
pnpm --filter @frameos-cloud/auth-web ai:eval --only create-word-clock --no-judge
pnpm --filter @frameos-cloud/auth-web ai:eval --compare evals/results/<older>/report.json
pnpm --filter @frameos-cloud/auth-web ai:eval:models             # QUICK_SET × default models
pnpm --filter @frameos-cloud/auth-web ai:eval:models --models gpt-5.6-terra,gpt-5.6-luna --all
pnpm --filter @frameos-cloud/auth-web ai:render weather --out /tmp/weather.png
pnpm --filter @frameos-cloud/auth-web ai:build-scenes --filter S --limit 5
```

Results land in `evals/results/<runId>/` (gitignored): `report.md`,
`report.json` and `png/` with every render. `--compare` prints a case-by-case
diff against an earlier run — the way to see what a prompt or linter change
moved.

## Anatomy

- `cases/scenes.ts` — the suite. `create` cases start from an empty editor;
  `modify` cases open a store scene by slug exactly as the store editor does
  (context block + `storeSceneId`); `ask` cases must NOT deliver a scene.
- `lib/checks.ts` — deterministic checks: delivered/not, apps used, scene
  fields, refresh interval, node-id preservation for edits, lint clean,
  render ok / not blank, judge score.
- `lib/judge.ts` — vision judge (`gpt-5.5`, structured output, 1–5).
- `lib/runner.ts` — one case through `runAgentLoop`, with the automatic
  `[Automatic render check]` follow-up (max 2) mirroring the editor.
- `../src/lib/ai/eval/render-check.ts` — the headless renderer.
- `build-todo-scenes.ts` — builds the scenes in `docs/scenes-todo.md`: prompt
  → render → judge → design-review turns until the score clears `--min-score`
  (default 4) or attempts run out, then publishes each as a private store
  scene with the render as preview.

`ai:eval:models` runs the same cases against several models (default:
gpt-5.5 vs the three gpt-5.6 tiers) with the judge pinned to one model, and
writes `evals/results/models-<runId>/compare.md` — a metric × model table
with estimated cost — plus a full per-model report each. It defaults to
`QUICK_SET` (9 cases, one per capability) to keep a 4-model run affordable;
`--all` runs the whole suite.

## Reading a report

`bounces` = delivery tool calls the linter refused before one validated —
the direct measure of how well the model knows the scene structure. `rounds`
= model round-trips per turn. A case fails when any check fails; the judge's
prose says why the render fell short.
