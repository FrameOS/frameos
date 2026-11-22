import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { useRef } from 'react'
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { Modal } from './Modal'
import { Select } from './Select'
import { Spinner } from './Spinner'
import {
  UPLOAD_RESIZE_CUSTOM,
  UPLOAD_RESIZE_FITS,
  UPLOAD_RESIZE_FORMATS,
  resizeUploadLogic,
  type UploadResizeSizeChoice,
} from './resizeUploadLogic'

const fieldClassName =
  'frameos-input h-10 rounded-xl border border-white/90 bg-white/90 px-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-blue-400'
const buttonClassName =
  'flex h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * "Resize and upload": the size as a longer and a shorter edge, how a photo
 * meets it and the format, then the files. They are resized in this browser
 * and go up through the page's own upload (resizeUploadLogic).
 */
export function ResizeUploadDialog(): JSX.Element | null {
  const {
    target,
    sizeKey,
    sizeChoices,
    longEdge,
    shortEdge,
    fit,
    format,
    quality,
    upscale,
    background,
    keepMetadata,
    options,
    progress,
    failures,
  } = useValues(resizeUploadLogic)
  const {
    closeResizeUpload,
    setSize,
    setLongEdge,
    setShortEdge,
    setFit,
    setFormat,
    setQuality,
    setUpscale,
    setBackground,
    setKeepMetadata,
    resizeAndUpload,
  } = useActions(resizeUploadLogic)
  const inputRef = useRef<HTMLInputElement>(null)
  if (!target) {
    return null
  }
  const groups: { label: string; group: UploadResizeSizeChoice['group'] }[] = [
    { label: 'From a frame', group: 'frames' },
    { label: 'Common sizes', group: 'presets' },
  ]
  const sizeOptions = [
    ...groups
      .map(({ label, group }) => ({
        label,
        options: sizeChoices
          .filter((choice) => choice.group === group)
          .map((choice) => ({ value: choice.key, label: choice.label })),
      }))
      .filter((group) => group.options.length),
    { value: UPLOAD_RESIZE_CUSTOM, label: 'Custom size' },
  ]
  const fitHint = UPLOAD_RESIZE_FITS.find((item) => item.value === fit)?.hint
  const lossy = format === 'jpeg' || format === 'webp' || format === 'keep'
  const padsOrFlattens = fit === 'contain' || format === 'jpeg' || format === 'keep'
  const shortTooLong = longEdge !== null && shortEdge !== null && shortEdge > longEdge
  const busy = progress !== null
  return (
    <Modal title={`Resize and upload to ${target.title}`} onClose={closeResizeUpload} panelClassName="max-w-[32rem]">
      <div className="space-y-4 p-5">
        <p className="frameos-muted text-sm">
          Photos are made smaller in this browser before they go up. The size is the box's longer and shorter edge,
          turned to suit each photo, landscape or portrait. Files that are not photos go up as they are.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="frameos-strong font-semibold">Size</span>
            <Select
              value={sizeKey}
              options={sizeOptions}
              disabled={busy}
              onChange={(key) => {
                const choice = sizeChoices.find((item) => item.key === key)
                setSize(key, choice?.longEdge ?? longEdge, choice?.shortEdge ?? shortEdge)
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="frameos-strong font-semibold">Longer edge</span>
            <input
              type="number"
              min={1}
              max={16384}
              value={longEdge ?? ''}
              disabled={busy}
              onChange={(event) => setLongEdge(event.target.value === '' ? null : Number(event.target.value))}
              className={fieldClassName}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="frameos-strong font-semibold">Shorter edge</span>
            <input
              type="number"
              min={1}
              max={16384}
              value={shortEdge ?? ''}
              placeholder={fit === 'inside' ? 'any' : ''}
              disabled={busy}
              onChange={(event) => setShortEdge(event.target.value === '' ? null : Number(event.target.value))}
              className={fieldClassName}
            />
          </label>
          {shortTooLong ? (
            <p className="text-xs text-red-700 sm:col-span-2">The shorter edge is longer than the longer one.</p>
          ) : null}
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="frameos-strong font-semibold">How the photo meets the size</span>
            <Select
              value={fit}
              disabled={busy}
              onChange={(value) => setFit(value as typeof fit)}
              options={UPLOAD_RESIZE_FITS.map(({ value, label }) => ({ value, label }))}
            />
            {fitHint ? <span className="frameos-muted text-xs">{fitHint}</span> : null}
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={upscale}
              disabled={busy}
              onChange={(event) => setUpscale(event.target.checked)}
            />
            <span>Enlarge photos smaller than this size</span>
          </label>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={keepMetadata}
              disabled={busy}
              onChange={(event) => setKeepMetadata(event.target.checked)}
            />
            <span>
              Keep metadata, location included
              <span className="frameos-muted block text-xs">
                {keepMetadata
                  ? 'Date taken, camera and GPS location go with each photo; one that already fits goes up untouched.'
                  : 'Every photo goes up without its date taken, camera and location, one that already fits written again.'}
              </span>
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="frameos-strong font-semibold">Format</span>
            <Select
              value={format}
              disabled={busy}
              onChange={(value) => setFormat(value as typeof format)}
              options={UPLOAD_RESIZE_FORMATS}
            />
            {format === 'keep' ? (
              <span className="frameos-muted text-xs">A format the browser cannot write (HEIC, GIF) becomes JPEG.</span>
            ) : null}
          </label>
          {lossy ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="frameos-strong font-semibold">Quality: {quality}</span>
              <input
                type="range"
                min={1}
                max={100}
                value={quality}
                disabled={busy}
                onChange={(event) => setQuality(Number(event.target.value))}
                className="mt-2"
              />
              <span className="frameos-muted text-xs">For JPEG and WebP. Frames show no difference above 85.</span>
            </label>
          ) : null}
          {padsOrFlattens ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="frameos-strong font-semibold">Background</span>
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(background) ? background : '#ffffff'}
                  disabled={busy}
                  onChange={(event) => setBackground(event.target.value)}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-white/90 bg-white/90 p-1"
                />
                <span className="frameos-muted text-xs">
                  {fit === 'contain' ? 'Fills the padding, and is behind' : 'Behind'} transparent parts of a JPEG.
                </span>
              </span>
            </label>
          ) : null}
        </div>
        {progress ? (
          <div className="flex items-center gap-3 text-sm">
            <Spinner className="h-4 w-4" />
            <span>
              Resizing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </span>
            <span className="frameos-divider ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
              <span
                className="block h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </span>
          </div>
        ) : null}
        {failures.length ? (
          <p className="text-sm text-red-700">
            {failures.length === 1 ? 'This file' : 'These files'} could not be read as a photo by this browser and{' '}
            {failures.length === 1 ? 'was' : 'were'} not uploaded: {failures.join(', ')}. The rest went up.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeResizeUpload}
            className={clsx(buttonClassName, 'frameos-secondary-button')}
          >
            {failures.length ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            disabled={!options || busy}
            onClick={() => inputRef.current?.click()}
            className={clsx(buttonClassName, 'frameos-primary-action text-white')}
          >
            <ArrowUpTrayIcon className="h-5 w-5" />
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={target.accept}
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) {
                resizeAndUpload(files)
              }
            }}
          />
        </div>
      </div>
    </Modal>
  )
}
