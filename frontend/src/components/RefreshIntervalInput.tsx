import { describeRefreshSeconds } from '../utils/refreshInterval'
import { NumberTextInput, NumberTextInputProps } from './NumberTextInput'

/**
 * The input for a scene's refresh interval (the state field with
 * `role: 'refreshInterval'`): seconds, with what they add up to next to it,
 * so "86400" reads as "1 day" and "0.0416" as "24 fps".
 */
export function RefreshIntervalInput({ value, ...props }: NumberTextInputProps): JSX.Element {
  const hint = describeRefreshSeconds(value)
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
