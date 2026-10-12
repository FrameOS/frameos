import clsx from 'clsx'

import type { FrameDeployProgressStep, FrameDeployProgressView } from '../decorators/frame'
import { Spinner } from './Spinner'

/**
 * The thin bar a deploy, update, restart or reboot draws under a frame's
 * name while the control plane runs it: the stage word (and the device's
 * own detail or download percentage) above a track that fills along the
 * kind's stages (docs/deploy-progress-contract.json). Green and full once it
 * is over, red with the reason when it failed; the caller hides it again
 * after a few seconds (frameDeployProgress returns null).
 */
export function DeployProgressBar({
  progress,
  className,
}: {
  progress: FrameDeployProgressView
  className?: string
}): JSX.Element {
  const fill =
    progress.status === 'error'
      ? 'bg-red-400'
      : progress.status === 'done'
      ? 'bg-emerald-400'
      : 'bg-[color:var(--frameos-primary)]'
  return (
    <span
      className={clsx('frameos-deploy-progress block min-w-0', className)}
      title={progress.title}
      role="progressbar"
      aria-label={progress.kindLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
      data-deploy-stage={progress.stage}
      data-deploy-status={progress.status}
    >
      <span className="flex min-w-0 items-center gap-2 text-xs leading-4">
        <span
          className={clsx(
            'min-w-0 flex-1 truncate',
            progress.status === 'error' ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'
          )}
        >
          {progress.caption}
        </span>
        {progress.status === 'running' ? (
          <span className="shrink-0 tabular-nums text-slate-400">{progress.percent}%</span>
        ) : null}
      </span>
      <span className="frameos-inset mt-1 block h-1 w-full overflow-hidden rounded-full">
        <span
          className={clsx('block h-full rounded-full transition-[width] duration-500', fill)}
          style={{ width: `${Math.max(progress.status === 'running' ? 4 : 0, progress.percent)}%` }}
        />
      </span>
    </span>
  )
}

/**
 * The deploy drawer's view of the same record: the kind's whole stage list,
 * what is done, what is happening now (with the device's own detail) and
 * what is still to come — the step list the SSH plan probe already draws.
 */
export function DeployProgressSteps({
  progress,
  steps,
}: {
  progress: FrameDeployProgressView
  steps: FrameDeployProgressStep[]
}): JSX.Element {
  return (
    <section className="space-y-3" aria-label={progress.kindLabel}>
      <div className="frame-tool-heading flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <span className="flex-1 truncate">{progress.kindLabel}</span>
        {progress.status === 'running' ? (
          <span className="frame-tool-muted tabular-nums normal-case tracking-normal">{progress.percent}%</span>
        ) : null}
      </div>
      <DeployProgressBar progress={progress} />
      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step.stage} className="flex gap-3 text-sm" data-deploy-step={step.stage} data-state={step.state}>
            {step.state === 'current' ? (
              <Spinner className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" />
            ) : (
              <span
                className={clsx(
                  'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
                  step.state === 'done' ? 'bg-emerald-400' : step.state === 'error' ? 'bg-red-400' : 'bg-slate-300/70'
                )}
              />
            )}
            <span className="min-w-0 flex-1">
              <span
                className={clsx(
                  'block',
                  step.state === 'pending' ? 'frame-tool-muted' : 'font-semibold text-[color:var(--tool-strong)]'
                )}
              >
                {step.label}
              </span>
              {step.detail ? (
                <span className="frame-tool-muted mt-0.5 block truncate text-xs">{step.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
