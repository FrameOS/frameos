import type { TestInfo } from '@playwright/test'

// The backends the suite runs against. One by default (port 8989, what a
// local run has always used). CI starts FRONTEND_VISUAL_BACKENDS of them,
// each with its own database, photos folder and Redis server
// (scripts/start-backend.sh, FRONTEND_VISUAL_INSTANCE), and every worker
// talks to backend `parallelIndex % count` (fixtures.ts). A worker runs its
// tests one after another, so a backend sees what it saw when the whole
// shard ran in one worker: tests that create frames or photos cannot show up
// in another worker's screenshots.
export const backendCount = Math.max(1, Number(process.env.FRONTEND_VISUAL_BACKENDS ?? '1') || 1)

const basePort = Number(process.env.FRONTEND_VISUAL_PORT ?? '8989')

export function backendPort(instance: number): number {
  return basePort + instance
}

export function backendURLForWorker(parallelIndex: number): string {
  return `http://127.0.0.1:${backendPort(parallelIndex % backendCount)}`
}

// The base URL a test, a hook or a request context of this worker should use.
export function workerBaseURL(testInfo: TestInfo): string | undefined {
  return backendCount > 1 ? backendURLForWorker(testInfo.parallelIndex) : testInfo.project.use.baseURL
}
