import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { CheckIcon, FolderIcon, PhotoIcon } from '@heroicons/react/24/outline'
import { router } from 'kea-router'
import type { FrameType } from '../../types'
import { Spinner } from '../../components/Spinner'
import { Select } from '../../components/Select'
import { RefreshIntervalInput } from '../../components/RefreshIntervalInput'
import { urls } from '../../urls'
import { installPhotoScenesLogic } from './installPhotoScenesLogic'
import { photoThumbUrl } from './photosApi'
import { PHOTO_ALBUM_FITS, PHOTO_ALBUM_ORDERS, type PhotoAlbumFit, type PhotoAlbumOrder } from './photoAlbumScene'
import { photoCountLabel } from './photoPaths'

/** The Add scene drawer's "Photos" page: tick albums, pick the timing, and
 * install one scene per album on this frame. */
export function InstallPhotoScenes({ frame }: { frame: FrameType }): JSX.Element {
  const logic = installPhotoScenesLogic({ frameId: frame.id })
  const { library, libraryLoading, choices, selectedAlbums, seconds, order, fit, installing, error, canInstall } =
    useValues(logic)
  const { toggleAlbum, setSeconds, setOrder, setFit, install } = useActions(logic)

  if (!library && libraryLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (library && !library.ready) {
    return (
      <div className="space-y-2 py-6 text-sm">
        <div className="frameos-strong font-semibold">Photos is not set up yet</div>
        <p className="frameos-muted">{library.message || 'Open Photos to see what it needs.'}</p>
        <a
          href={urls.photos()}
          onClick={(event) => {
            event.preventDefault()
            router.actions.push(urls.photos())
          }}
          className="frameos-link font-semibold"
        >
          Open Photos
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-2">
      <div className="space-y-2">
        <div className="frameos-muted text-xs font-semibold uppercase tracking-wide">Albums</div>
        {choices.length === 0 ? (
          <div className="frameos-inset space-y-2 rounded-2xl border p-4 text-sm">
            <p className="frameos-muted">No albums yet. Make one in Photos and add a few photos to it.</p>
            <a
              href={urls.photos()}
              onClick={(event) => {
                event.preventDefault()
                router.actions.push(urls.photos())
              }}
              className="frameos-link font-semibold"
            >
              Open Photos
            </a>
          </div>
        ) : (
          <div className="grid gap-2">
            {choices.map((choice) => {
              const checked = selectedAlbums.includes(choice.path)
              const entry = choice.entry
              return (
                <button
                  key={choice.path}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleAlbum(choice.path)}
                  className={clsx(
                    'frameos-card flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400',
                    checked ? 'frameos-selected-surface ring-2 ring-blue-400' : 'border-white/90 bg-white/80'
                  )}
                >
                  <span className="frameos-inset flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-slate-400">
                    {entry?.cover ? (
                      <img
                        src={photoThumbUrl({ path: entry.cover, mtime: entry.mtime, size: entry.size })}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <FolderIcon className="h-5 w-5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="frameos-strong block truncate text-sm font-semibold">{choice.name}</span>
                    <span className="frameos-muted block truncate text-xs">
                      {entry ? photoCountLabel(entry.files) : choice.path}
                    </span>
                  </span>
                  <span
                    className={clsx(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
                      checked ? 'frameos-primary-active border-transparent text-white' : 'border-slate-300'
                    )}
                  >
                    {checked ? <CheckIcon className="h-4 w-4" /> : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <label className="block space-y-1.5">
        <span className="frameos-form-label text-sm font-medium">Seconds to show one photo</span>
        <RefreshIntervalInput value={seconds} onChange={setSeconds} />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <span className="frameos-form-label text-sm font-medium">Order</span>
          <Select value={order} onChange={(value) => setOrder(value as PhotoAlbumOrder)} options={PHOTO_ALBUM_ORDERS} />
        </label>
        <label className="block space-y-1.5">
          <span className="frameos-form-label text-sm font-medium">Fit</span>
          <Select value={fit} onChange={(value) => setFit(value as PhotoAlbumFit)} options={PHOTO_ALBUM_FITS} />
        </label>
      </div>

      {error ? <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}

      <button
        type="button"
        disabled={!canInstall}
        onClick={install}
        className="frameos-primary-action flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {installing ? <Spinner className="h-4 w-4" color="white" /> : <PhotoIcon className="h-5 w-5" />}
        {selectedAlbums.length > 1
          ? `Install ${selectedAlbums.length} scenes`
          : selectedAlbums.length === 1
          ? 'Install scene'
          : 'Pick an album'}
      </button>
      <p className="frameos-muted text-xs">
        Each album becomes a scene on {frame.name || 'this frame'}. Deploy to send it to the frame.
      </p>
    </div>
  )
}
