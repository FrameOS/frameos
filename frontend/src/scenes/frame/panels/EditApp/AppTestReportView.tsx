import clsx from 'clsx'
import { CheckCircleIcon, MinusCircleIcon, XCircleIcon } from '@heroicons/react/24/solid'
import type { AppTestRun } from './editAppLogic'
import type { AppTestLogLine, AppTestReport, AppTestResult, AppTestSuiteResult } from '../../../../utils/appTestRunner'

// The report of one test file as the editor shows it: a nested section per
// describe, a row per test, and under a failed test its message, what was
// expected and received, the stack and what it logged.

function StatusIcon({
  status,
  className,
}: {
  status: 'passed' | 'failed' | 'skipped'
  className?: string
}): JSX.Element {
  if (status === 'passed') {
    return <CheckCircleIcon className={clsx('text-emerald-500', className)} aria-label="passed" />
  }
  if (status === 'failed') {
    return <XCircleIcon className={clsx('text-red-500', className)} aria-label="failed" />
  }
  return <MinusCircleIcon className={clsx('text-slate-400', className)} aria-label="skipped" />
}

function Logs({ logs }: { logs: AppTestLogLine[] }): JSX.Element | null {
  if (!logs.length) {
    return null
  }
  return (
    <details className="mt-1">
      <summary className="frameos-muted cursor-pointer text-xs">
        {logs.length} log line{logs.length === 1 ? '' : 's'}
      </summary>
      <pre className="frameos-inset mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-xs">
        {logs.map((line, index) => (
          <div
            key={index}
            className={clsx(
              line.level === 'error' ? 'text-red-700 dark:text-red-300' : null,
              line.level === 'warn' ? 'text-amber-700 dark:text-amber-300' : null
            )}
          >
            {line.level === 'log' ? '' : `${line.level}: `}
            {line.text}
          </div>
        ))}
      </pre>
    </details>
  )
}

function TestRow({ test, depth }: { test: AppTestResult; depth: number }): JSX.Element {
  return (
    <div className="py-0.5" style={{ paddingLeft: depth * 16 }}>
      <div className="flex items-center gap-2 text-sm">
        <StatusIcon status={test.status} className="h-4 w-4 shrink-0" />
        <span className={clsx('min-w-0 flex-1 truncate', test.status === 'skipped' ? 'frameos-muted' : null)}>
          {test.name}
        </span>
        {test.status !== 'skipped' ? (
          <span className="frameos-muted shrink-0 text-xs">{test.durationMs} ms</span>
        ) : null}
      </div>
      {test.error ? (
        <div className="ml-6 mt-1 rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="whitespace-pre-wrap font-semibold">{test.error.message}</div>
          {test.error.expected !== undefined || test.error.received !== undefined ? (
            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 font-mono">
              <span>expected</span>
              <span className="break-all">{test.error.expected}</span>
              <span>received</span>
              <span className="break-all">{test.error.received}</span>
            </div>
          ) : null}
          {test.error.stack ? (
            <details className="mt-1">
              <summary className="cursor-pointer">stack</summary>
              <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono">{test.error.stack}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="ml-6">
        <Logs logs={test.logs} />
      </div>
    </div>
  )
}

function SuiteRows({ suite, depth }: { suite: AppTestSuiteResult; depth: number }): JSX.Element {
  return (
    <details open className="py-0.5" style={{ paddingLeft: depth * 16 }}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
        <StatusIcon status={suite.status} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{suite.name || 'tests'}</span>
      </summary>
      {suite.error ? (
        <div className="ml-6 mt-1 rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="whitespace-pre-wrap font-semibold">{suite.error.message}</div>
        </div>
      ) : null}
      <div>
        {suite.children.map((child, index) =>
          child.kind === 'suite' ? (
            <SuiteRows key={index} suite={child} depth={1} />
          ) : (
            <TestRow key={index} test={child} depth={1} />
          )
        )}
      </div>
    </details>
  )
}

export function reportSummary(report: AppTestReport): string {
  if (report.error) {
    return 'Could not run the tests'
  }
  const parts = [`${report.counts.passed} passed`]
  if (report.counts.failed) {
    parts.push(`${report.counts.failed} failed`)
  }
  if (report.counts.skipped) {
    parts.push(`${report.counts.skipped} skipped`)
  }
  return `${parts.join(', ')} in ${report.durationMs} ms`
}

export function AppTestReportView({ run }: { run: AppTestRun }): JSX.Element {
  if (run.status === 'running') {
    return <div className="frameos-muted p-3 text-sm">Running the tests in the FrameOS runtime…</div>
  }
  if (run.status === 'failed') {
    return (
      <div className="p-3 text-sm">
        <div className="rounded-lg bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
          {run.error}
        </div>
      </div>
    )
  }
  const { report } = run
  return (
    <div className="p-3">
      <div
        className={clsx(
          'mb-2 flex items-center gap-2 text-sm font-semibold',
          report.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
        )}
      >
        <StatusIcon status={report.ok ? 'passed' : 'failed'} className="h-5 w-5" />
        {reportSummary(report)}
      </div>
      {report.error ? (
        <pre className="whitespace-pre-wrap rounded-lg bg-red-50 p-2 font-mono text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
          {report.error}
        </pre>
      ) : null}
      <div>
        {report.children.map((child, index) =>
          child.kind === 'suite' ? (
            <SuiteRows key={index} suite={child} depth={0} />
          ) : (
            <TestRow key={index} test={child} depth={0} />
          )
        )}
      </div>
      <Logs logs={report.logs} />
    </div>
  )
}
