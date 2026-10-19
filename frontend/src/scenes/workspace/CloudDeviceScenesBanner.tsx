import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { ArrowDownTrayIcon, ArrowPathRoundedSquareIcon, XMarkIcon } from '@heroicons/react/24/solid'

import { Spinner } from '../../components/Spinner'
import { framesModel } from '../../models/framesModel'
import type { FrameType } from '../../types'
import {
  deviceScenesCompiledNotes,
  deviceScenesConvertible,
  deviceScenesOffer,
  deviceScenesPlainImportable,
  deviceScenesWorthShowing,
} from '../../utils/cloudDeviceScenes'
import { workspaceMode } from './workspaceSurfaces'

/**
 * A frame that ran on its own before it joined FrameOS Cloud keeps rendering
 * its scenes, but the cloud — whose model is store scenes assigned to frames —
 * lists it as empty. The hub asks such a frame what it holds (`scenes_get`,
 * docs/cloud-frames.md); this is the offer to bring the answer into the
 * account: private drafts, added to the frame, sent back to it with the
 * scene on screen kept. Also the place the outcome is read afterwards — a
 * scene the store refused must not just be missing. Compiled (Nim) scenes
 * the frame sent are imported only through "Convert and import", which
 * converts them to interpreted scenes first; ones the frame could only name
 * are explained, not offered.
 *
 * Renders nothing outside the cloud, for a frame that reported nothing, and
 * until the owner has confirmed the frame (nothing can be sent before that,
 * and the confirm banner is already asking for the one thing that matters).
 */
export function CloudDeviceScenesBanner({ frame }: { frame: FrameType }): JSX.Element | null {
  const { cloudDeviceScenes, cloudDeviceScenesBusy, cloudDeviceScenesNotices } = useValues(framesModel)
  const { importCloudDeviceScenes, dismissCloudDeviceScenes, clearCloudDeviceScenesNotice } = useActions(framesModel)

  if (workspaceMode() !== 'cloud' || frame.status === 'pending') {
    return null
  }
  const deviceScenes = cloudDeviceScenes[frame.id]
  const notice = cloudDeviceScenesNotices[frame.id]
  const busy = cloudDeviceScenesBusy[frame.id]
  const showing = deviceScenesWorthShowing(deviceScenes)
  if (!showing && !notice && !busy) {
    return null
  }
  const plain = deviceScenesPlainImportable(deviceScenes)
  const convertible = deviceScenesConvertible(deviceScenes)
  // A `partial` import leaves the report waiting: the same button finishes it.
  const retrying = plain && deviceScenes?.result?.status === 'partial'
  const compiledNotes = showing && deviceScenes ? deviceScenesCompiledNotes(deviceScenes) : []

  return (
    <div
      data-cloud-device-scenes={frame.id}
      className={clsx(
        'frameos-blank-frame-scene-hint mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-medium leading-5 shadow-sm',
        notice?.error
          ? 'border-red-200 bg-red-50 text-red-950'
          : 'border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100'
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        {showing && deviceScenes ? (
          <p>
            {deviceScenesOffer(deviceScenes)}{' '}
            {plain || convertible ? (
              <span className="font-normal">
                Import them to see, edit and schedule them here. They become private scenes in your account and are sent
                back to the frame; the copies on the frame itself are left alone, and none of your service keys are
                shared with it.
              </span>
            ) : null}
          </p>
        ) : null}
        {compiledNotes.map((line, index) => (
          <p key={`compiled-${index}`} className="font-normal">
            {line}
          </p>
        ))}
        {notice?.lines.map((line, index) => (
          <p key={index} className={clsx(index > 0 && 'font-normal')}>
            {line}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showing ? (
          <>
            {plain ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                aria-busy={busy === 'importing'}
                onClick={() => importCloudDeviceScenes(frame.id)}
                className="frameos-primary-action inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'importing' ? (
                  <Spinner className="h-4 w-4 [&>svg]:h-full [&>svg]:w-full" />
                ) : (
                  <ArrowDownTrayIcon aria-hidden className="h-4 w-4" />
                )}
                {busy === 'importing' ? 'Importing…' : retrying ? 'Import the rest' : 'Import scenes'}
              </button>
            ) : null}
            {convertible ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                aria-busy={busy === 'converting'}
                onClick={() => importCloudDeviceScenes(frame.id, true)}
                title="Convert the compiled scenes to interpreted scenes, then import everything"
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50',
                  plain
                    ? 'border border-sky-300 text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:text-sky-100 dark:hover:bg-sky-900/50'
                    : 'frameos-primary-action text-white'
                )}
              >
                {busy === 'converting' ? (
                  <Spinner className="h-4 w-4 [&>svg]:h-full [&>svg]:w-full" />
                ) : (
                  <ArrowPathRoundedSquareIcon aria-hidden className="h-4 w-4" />
                )}
                {busy === 'converting' ? 'Converting…' : 'Convert and import'}
              </button>
            ) : null}
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => dismissCloudDeviceScenes(frame.id)}
              className="rounded-lg px-2 py-2 text-xs font-semibold text-sky-900 transition hover:bg-sky-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-sky-100 dark:hover:bg-sky-900/50"
            >
              Not now
            </button>
          </>
        ) : notice ? (
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={() => clearCloudDeviceScenesNotice(frame.id)}
            className="rounded-lg p-1.5 transition hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <XMarkIcon aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
