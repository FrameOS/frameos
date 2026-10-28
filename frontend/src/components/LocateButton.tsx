import { useActions, useValues } from 'kea'
import { MapPinIcon } from '@heroicons/react/24/outline'
import { Spinner } from './Spinner'
import { locateButtonLogic } from './locateButtonLogic'
import type { GeoLocation } from '../utils/geolocation'

/** A form row's input with a square "use my location" button at its end. */
export function WithLocateButton({
  onLocate,
  children,
}: {
  onLocate: (location: GeoLocation) => void
  children: JSX.Element
}): JSX.Element {
  const { locating, error } = useValues(locateButtonLogic)
  const { locate } = useActions(locateButtonLogic)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          onClick={() => locate(onLocate)}
          disabled={locating}
          aria-label="Use my location"
          title="Use my location: set the latitude and longitude to where this device is"
          className="frameos-button frameos-secondary-button flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {locating ? <Spinner /> : <MapPinIcon className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {error ? <div className="text-xs text-red-500">{error}</div> : null}
    </div>
  )
}
