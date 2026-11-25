import { Popover, Transition } from '@headlessui/react'
import { A } from 'kea-router'
import clsx from 'clsx'
import ReactDOM from 'react-dom'
import { useState, type ReactNode } from 'react'
import { usePopper } from 'react-popper'

import { StorageGlyph, StorageIndicator, storageTitle, storageToneText } from '../../components/StorageIndicator'
import type { FrameType } from '../../types'
import {
  frameStorageLabel,
  frameStorageSummary,
  frameStorageTone,
  type FrameStorageSummary,
  type FrameStorageTone,
} from '../../utils/frameSceneStorage'
import { formatBytes } from '../settings/account/format'
import { urls } from '../../urls'
import { sceneToolPanelDisabledReason, sceneToolPanelIsAllowed, workspaceMode } from './workspaceSurfaces'

const toneFill: Record<FrameStorageTone, string> = {
  ok: '#0ea5e9',
  filling: '#f59e0b',
  full: '#ef4444',
}

const toneLabel: Record<FrameStorageTone, string> = {
  ok: 'used',
  filling: 'used, filling up',
  full: 'used, almost full',
}

/** The other files' share of the bar: neither the scenes' color nor the free track. */
const otherFill = '#94a3b8'

/**
 * The disk popup, the battery popup's sibling (FrameBatteryPopover): how full
 * an ESP32's state partition is, what its scenes take and what everything else
 * does, and each scene's size, largest first. From what the frame last
 * reported (`embedded.storage` on a backend, `hardware.storage` on the cloud:
 * utils/frameSceneStorage.ts), so it shows only on a frame that reports it.
 *
 * The trigger is one button around the glyph + number, its look the caller's
 * (HeaderMetrics gives it the metric chips' beside the battery chip).
 */
export function FrameStorageIndicator({
  frame,
  className,
  children,
}: {
  frame: FrameType
  className?: string
  /** The trigger's content; defaults to the glyph + number. */
  children?: (summary: FrameStorageSummary) => ReactNode
}): JSX.Element | null {
  const summary = frameStorageSummary(frame)
  if (!summary) {
    return null
  }
  return (
    <FrameStoragePopover frame={frame} summary={summary} className={className}>
      {children ? children(summary) : <StorageIndicator percent={summary.usedPercent} title="" />}
    </FrameStoragePopover>
  )
}

function FrameStoragePopover({
  frame,
  summary,
  className,
  children,
}: {
  frame: FrameType
  summary: FrameStorageSummary
  className?: string
  children: ReactNode
}): JSX.Element {
  const [referenceElement, setReferenceElement] = useState<HTMLButtonElement | null>(null)
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null)
  const { styles, attributes } = usePopper(referenceElement, popperElement, {
    strategy: 'fixed',
    placement: 'bottom-end',
    modifiers: [
      { name: 'offset', options: { offset: [0, 8] } },
      { name: 'flip', options: { fallbackPlacements: ['bottom-start', 'top-end', 'top-start'], padding: 8 } },
      { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false } },
      // adaptive right/bottom anchoring miscomputes against the #popper portal; always anchor top-left
      { name: 'computeStyles', options: { adaptive: false } },
    ],
  })
  const portalTarget = typeof document === 'undefined' ? null : document.querySelector('#popper')
  // "14.1 MB free of 20.8 MB on the frame, scenes 389 KB": the line the scenes
  // row used to carry, now the trigger's tooltip.
  const label = frameStorageLabel(frame) ?? storageTitle(summary.usedPercent)

  return (
    <Popover className="contents">
      {({ open }) => (
        <>
          <Popover.Button
            ref={setReferenceElement}
            type="button"
            title={`${label}. Click for details.`}
            aria-label={`${storageTitle(summary.usedPercent)}. Disk details.`}
            data-testid="storage-button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className={clsx(
              'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
              className
            )}
          >
            {children}
          </Popover.Button>
          {portalTarget
            ? ReactDOM.createPortal(
                // opacity only: a transform on this wrapper would become the containing
                // block for the fixed-positioned panel and break popper's coordinates
                <Transition
                  show={open}
                  enter="transition ease-out duration-100"
                  enterFrom="opacity-0"
                  enterTo="opacity-100"
                  leave="transition ease-in duration-75"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <Popover.Panel
                    static
                    ref={setPopperElement}
                    style={styles.popper}
                    {...attributes.popper}
                    className="frameos-tooltip-panel z-50 w-[20rem] max-w-[calc(100vw-1rem)] rounded-xl p-3.5 text-left text-xs focus:outline-none"
                    data-testid="storage-popover"
                  >
                    {({ close }) =>
                      open ? <StoragePanel frame={frame} summary={summary} onNavigate={() => close()} /> : <></>
                    }
                  </Popover.Panel>
                </Transition>,
                portalTarget
              )
            : null}
        </>
      )}
    </Popover>
  )
}

function StoragePanel({
  frame,
  summary,
  onNavigate,
}: {
  frame: FrameType
  summary: FrameStorageSummary
  onNavigate: () => void
}): JSX.Element {
  const tone = frameStorageTone(summary.usedPercent)
  const filesLink =
    sceneToolPanelIsAllowed(workspaceMode(), 'assets', frame) &&
    !sceneToolPanelDisabledReason(workspaceMode(), 'assets', frame)
  return (
    <div className="flex flex-col gap-3" data-storage-tone={tone}>
      <div className="flex items-center gap-3">
        <span className={storageToneText[tone]}>
          <StorageGlyph percent={summary.usedPercent} strokeWidth={3} className="h-11 w-11" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold leading-none tabular-nums">{summary.usedPercent}%</span>
            <span className="text-[11px] font-semibold" style={{ color: toneFill[tone] }} data-testid="storage-status">
              {toneLabel[tone]}
            </span>
          </div>
          <div className="frameos-muted mt-1 truncate text-[11px] tabular-nums">
            {formatBytes(summary.freeBytes)} free of {formatBytes(summary.totalBytes)}
          </div>
        </div>
      </div>

      <StorageBar summary={summary} tone={tone} />

      <div
        className="grid grid-cols-6 gap-x-3 gap-y-2 rounded-lg bg-slate-500/[0.07] px-3 py-2"
        data-testid="storage-facts"
      >
        <Fact className="col-span-2" label="Used" value={formatBytes(summary.usedBytes)} />
        <Fact className="col-span-2" label="Free" value={formatBytes(summary.freeBytes)} />
        <Fact className="col-span-2" label="Total" value={formatBytes(summary.totalBytes)} />
        <Fact
          className="col-span-3"
          label="Scenes"
          swatch={toneFill[tone]}
          value={`${formatBytes(summary.scenesBytes)} · ${summary.sceneCount} ${
            summary.sceneCount === 1 ? 'scene' : 'scenes'
          }`}
        />
        <Fact
          className="col-span-3"
          label="Other files"
          swatch={otherFill}
          value={formatBytes(summary.otherBytes)}
          title="Files kept on the frame, saved scene state and the frame's own files."
        />
      </div>

      <SceneSizes summary={summary} tone={tone} />

      <div className="frameos-muted flex items-center justify-between gap-2 border-t border-slate-500/15 pt-2 text-[11px]">
        <span>As the frame last reported it</span>
        {filesLink ? (
          <A
            href={urls.frame(frame.id, 'assets')}
            className="font-semibold underline-offset-2 hover:underline"
            onClick={onNavigate}
          >
            Open files
          </A>
        ) : null}
      </div>
    </div>
  )
}

/** The partition as one bar: the scenes, everything else, then what is free. */
function StorageBar({ summary, tone }: { summary: FrameStorageSummary; tone: FrameStorageTone }): JSX.Element {
  const share = (bytes: number): string => `${(100 * bytes) / summary.totalBytes}%`
  const scenesBytes = Math.min(summary.scenesBytes, summary.usedBytes)
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-500/20" data-testid="storage-bar" aria-hidden>
      <span className="block h-full" style={{ width: share(scenesBytes), backgroundColor: toneFill[tone] }} />
      <span className="block h-full" style={{ width: share(summary.otherBytes), backgroundColor: otherFill }} />
    </div>
  )
}

function Fact({
  label,
  value,
  title,
  swatch,
  className,
}: {
  label: string
  value: ReactNode
  title?: string
  swatch?: string
  className?: string
}): JSX.Element {
  return (
    <div className={clsx('min-w-0', className)} title={title}>
      <div className="frameos-muted flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide">
        {swatch ? <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: swatch }} /> : null}
        {label}
      </div>
      <div className="truncate text-[12px] font-medium tabular-nums">{value}</div>
    </div>
  )
}

/** Each scene's size by name (its id where the frame's list does not name
 * it), largest first, with a bar against the largest. */
function SceneSizes({ summary, tone }: { summary: FrameStorageSummary; tone: FrameStorageTone }): JSX.Element | null {
  if (summary.scenes.length === 0) {
    return summary.sceneCount > 0 ? (
      <div className="frameos-muted text-[11px]">This frame&apos;s firmware does not say what each scene takes.</div>
    ) : null
  }
  const largest = summary.scenes[0].bytes || 1
  return (
    <div className="min-w-0">
      <div className="frameos-muted mb-1.5 text-[10px] font-semibold uppercase tracking-wide">Scenes by size</div>
      <ul className="-mr-1 max-h-72 space-y-1.5 overflow-y-auto pr-1" data-testid="storage-scenes">
        {summary.scenes.map((scene) => (
          <li key={scene.id} className="min-w-0" data-storage-scene={scene.id}>
            <div className="flex min-w-0 items-baseline gap-2">
              <span
                className={clsx('min-w-0 flex-1 truncate', scene.name ? 'font-medium' : 'frameos-muted font-mono')}
                title={scene.name ? scene.name : `${scene.id}: not in this frame's scene list`}
              >
                {scene.name ?? scene.id}
              </span>
              <span className="shrink-0 tabular-nums">{formatBytes(scene.bytes)}</span>
            </div>
            <span className="mt-0.5 block h-0.5 w-full overflow-hidden rounded-full bg-slate-500/15">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(100 * scene.bytes) / largest}%`, backgroundColor: toneFill[tone], opacity: 0.7 }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
