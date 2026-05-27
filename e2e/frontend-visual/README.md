# Frontend Visual Regression

This suite photographs the backend-served FrameOS frontend with Playwright. It complements the existing `e2e/` scene-renderer snapshots by testing the real web UI: routing, sidebars, tools, drawers, settings, logs, charts, assets, terminal, auth screens, and responsive layouts.

## Run Locally

1. Start Redis, for example `pnpm dev:redis`.
2. Build the frontend once: `pnpm --dir frontend run build`.
3. Install Playwright browsers once: `pnpm exec playwright install chromium`.
4. Run the e2e smoke coverage only: `pnpm test:frontend-e2e`.
5. Run the full e2e and visual comparison: `pnpm test:frontend-visual`.
6. Refresh snapshots intentionally: `pnpm test:frontend-visual:update`.

The Playwright web server command seeds a disposable SQLite database at `.tmp/frontend-visual.db`, uses Redis database 15 by default, then starts FastAPI on `127.0.0.1:8989`.

By default the suite owns that backend port so it cannot accidentally compare against a developer server with different data. To point at an already running backend, set `FRONTEND_VISUAL_SKIP_WEBSERVER=1`; to allow Playwright to reuse an existing server on the configured URL, set `FRONTEND_VISUAL_REUSE_SERVER=1`.

## Add A Page Or State

Add one entry to `tests/visual-cases.ts`:

```ts
{
  id: 'frame-new-tool',
  title: 'Frame new tool',
  path: '/frames/1?tool=new-tool',
  fullPage: true,
  variants: [
    { id: 'default' },
    { id: 'drawer-open', prepare: async (page) => page.getByRole('button', { name: /Open/i }).click() },
  ],
}
```

Each case is automatically captured in light and dark mode at mobile, mid, and full-width viewports unless you override `themes` or `viewports`. Keep fixture data in `scripts/seed_backend.py` when a page needs realistic backend state. Add non-screenshot route and interaction coverage to `tests/frontend-e2e.spec.ts` when a page has important buttons, drawers, or section navigation that should be exercised without multiplying snapshot count.

## CI Behavior

Pull requests from this repository run Playwright with `--update-snapshots`, then commit changed files under `e2e/frontend-visual/snapshots/`. Forked PRs and pushes to `main` compare against the committed snapshots without writing.
