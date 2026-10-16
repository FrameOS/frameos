import { assetUrl } from './assetUrl'

// Runs one test file of a JavaScript app in the frameos-wasm preview worker,
// the interpreter the app itself runs in (docs/js-apps-and-code-nodes.md,
// "Testing an app"). A worker of its own per run, started with an empty
// scene and torn down with the report: a test run is seconds long and must
// not disturb a live preview. The types mirror frameos/wasm/src/types.ts.

export interface AppTestLogLine {
  level: 'log' | 'warn' | 'error'
  text: string
}

export interface AppTestError {
  message: string
  stack: string
  expected?: string
  received?: string
}

export interface AppTestResult {
  kind: 'test'
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  logs: AppTestLogLine[]
  error?: AppTestError
}

export interface AppTestSuiteResult {
  kind: 'suite'
  name: string
  status: 'passed' | 'failed' | 'skipped'
  children: (AppTestResult | AppTestSuiteResult)[]
  error?: AppTestError
}

export interface AppTestReport {
  ok: boolean
  file?: string
  error?: string
  counts: { passed: number; failed: number; skipped: number; total: number }
  durationMs: number
  children: (AppTestResult | AppTestSuiteResult)[]
  logs: AppTestLogLine[]
}

export interface AppTestRunOptions {
  sources: Record<string, string>
  testFile: string
  /** The frame the tests see as app.frame (makeApp's defaults are 800x480 otherwise). */
  frame?: { width?: number | null; height?: number | null; timezone?: string | null }
  /** Run as an ESP32 does (app.frame.embedded in the preview). */
  embedded?: boolean
  /** How long to wait for the worker and the run, ms. */
  timeoutMs?: number
}

/** The scene the worker starts with: it needs one, the tests need none. */
const EMPTY_SCENE = {
  id: 'app-tests',
  name: 'App tests',
  nodes: [],
  edges: [],
  fields: [],
  settings: { execution: 'interpreted' },
}

export function runAppTestFile(options: AppTestRunOptions): Promise<AppTestReport> {
  const timeoutMs = options.timeoutMs ?? 60000
  return new Promise<AppTestReport>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(assetUrl('/frameos-wasm/preview-worker.js'), { type: 'module' })
    } catch (error) {
      reject(
        new Error(
          'Could not start the FrameOS runtime worker. Is the wasm bundle built? ' +
            'Run frameos/tools/build_wasm.sh (or the "wasm" mprocs pane) and reload.'
        )
      )
      return
    }
    let settled = false
    const finish = (outcome: { report?: AppTestReport; error?: string }): void => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      worker.terminate()
      if (outcome.report) {
        resolve(outcome.report)
      } else {
        reject(new Error(outcome.error ?? 'The test run failed.'))
      }
    }
    const timer = window.setTimeout(
      () => finish({ error: `The tests did not finish within ${Math.round(timeoutMs / 1000)} seconds.` }),
      timeoutMs
    )
    worker.onerror = (event) => {
      finish({ error: event.message || 'The FrameOS runtime worker failed to load.' })
    }
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data || {}
      switch (msg.type) {
        case 'ready':
          worker.postMessage({
            type: 'runAppTests',
            requestId: 1,
            appJson: JSON.stringify({ sources: options.sources }),
            testFile: options.testFile,
          })
          break
        case 'appTestsResult':
          if (msg.ok) {
            finish({ report: msg.report as AppTestReport })
          } else {
            finish({ error: String(msg.error ?? 'could not run the tests') })
          }
          break
        case 'error':
          finish({ error: String(msg.message ?? 'Unknown FrameOS runtime error') })
          break
        default:
          break
      }
    }
    worker.postMessage({
      type: 'init',
      width: options.frame?.width || 800,
      height: options.frame?.height || 480,
      name: 'app tests',
      timeZone: options.frame?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      scenesJson: JSON.stringify([EMPTY_SCENE]),
      settingsJson: '{}',
      proxyUrl: '',
      sceneId: EMPTY_SCENE.id,
      fastMode: false,
      saveAssets: false,
      browserAssets: false,
      embedded: options.embedded === true,
    })
  })
}
