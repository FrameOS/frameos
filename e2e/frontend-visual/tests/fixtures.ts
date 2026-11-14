import { test as base } from '@playwright/test'

import { backendCount, backendURLForWorker } from './backends'

// Every spec imports `test` (and `expect`) from here rather than from
// @playwright/test: the one difference is that `baseURL`, and with it every
// page, context and `request` of the test, points at this worker's own
// backend when the run has several (backends.ts).
export * from '@playwright/test'

export const test = base.extend({
  baseURL: async ({ baseURL }, use, testInfo) => {
    await use(backendCount > 1 ? backendURLForWorker(testInfo.parallelIndex) : baseURL)
  },
})
