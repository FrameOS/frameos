import { describeRefreshSeconds } from '../utils/refreshInterval'
import { NumberTextInput, NumberTextInputProps } from './NumberTextInput'

/**
 * The input for a scene's refresh interval (the state field with
 * `role: 'refreshInterval'`): seconds, with what they add up to next to it,
 * so "86400" reads as "1 day" and "0.0416" as "24 fps". A value that is no
 * interval (0, a negative number) says what the frame makes of it: the
 * scene's own interval, not "never" (an owner typed 0 into a schedule entry to
 * turn a 15 minute slideshow off, 2026-11-18).
 */
export function RefreshIntervalInput({ value, ...props }: NumberTextInputProps): JSX.Element {
  const typed = value === undefined || value === null ? '' : String(value).trim()
  const hint = describeRefreshSeconds(value) || (typed !== '' ? "the scene's own interval" : '')
  return (
    <div className="flex w-full items-center gap-2">
      <div className="min-w-0 flex-1">
        <NumberTextInput value={value} {...props} />
      </div>
      {hint ? (
        <span className="frameos-muted shrink-0 whitespace-nowrap text-xs" data-refresh-interval-hint>
          = {hint}
        </span>
      ) : null}
    </div>
  )
}
