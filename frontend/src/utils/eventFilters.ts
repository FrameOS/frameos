import type { AppConfigField, SelectFieldOption } from '../types'
import { buttonRoleByLabel } from './eventsContract.gen'

/** An event node's `data.config`: payload key -> the text the value must equal (docs/events.md "Filters"). */
export type EventFilterConfig = Record<string, unknown>

export interface EventFilterOption {
  value: string
  label: string
}

/** What the event node draws for one filter field. Every control starts with the "any" entry. */
export type EventFilterControl =
  | { kind: 'select'; options: EventFilterOption[] }
  | { kind: 'number' }
  | { kind: 'text' }

/** The frame's GPIO buttons as the device reports them (`hardware.gpioButtons`). */
export type FrameButton = { pin: number; label: string }

export const ANY_EVENT_FILTER_OPTION: EventFilterOption = { value: '', label: 'any' }

export function eventFilterIsSet(config: EventFilterConfig | undefined, name: string): boolean {
  const value = config?.[name]
  return value !== undefined && value !== null && String(value) !== ''
}

/**
 * The filter fields an event node shows: every field the catalog does not fold,
 * plus a folded one (`filter: "more"`) that has a value, plus all of them once
 * the node is unfolded. Catalog order throughout.
 */
export function eventFilterFieldsToShow(
  fields: AppConfigField[],
  config: EventFilterConfig | undefined,
  showMore: boolean
): AppConfigField[] {
  return fields.filter((field) => showMore || field.filter !== 'more' || eventFilterIsSet(config, field.name))
}

/** How many filters the "More filters" link would reveal. */
export function foldedEventFilterCount(fields: AppConfigField[], config: EventFilterConfig | undefined): number {
  return fields.filter((field) => field.filter === 'more' && !eventFilterIsSet(config, field.name)).length
}

function roleLabelsByRole(buttons: FrameButton[]): Record<string, string[]> {
  const byRole: Record<string, string[]> = {}
  for (const button of buttons) {
    const role = buttonRoleByLabel[String(button.label ?? '').toUpperCase()]
    if (role) {
      byRole[role] = [...(byRole[role] ?? []), button.label]
    }
  }
  return byRole
}

// The catalog's options are plain strings; `{ value, label }` is tolerated
// (utils/selectOptions.ts does the same for scene fields, but it types its
// options with the Select component, which the cloud typecheck must not reach
// from here).
function contractOption(option: SelectFieldOption, labelsByRole: Record<string, string[]>): EventFilterOption {
  const value = typeof option === 'string' ? option : String(option?.value ?? '')
  const label = typeof option === 'string' ? option : String(option?.label ?? value)
  return { value, label: labelsByRole[value] ? `${label} (${labelsByRole[value].join(', ')})` : label }
}

/**
 * The control for one filter field. A field the contract gives values to
 * (`options`) is a select; a boolean is a yes/no select; a `button` listener
 * on a frame whose buttons are known picks the label or the pin from a list,
 * and its role options say which of the frame's buttons map to them
 * (`buttons.roleByLabel`); a number is a number box; the rest is free text.
 */
export function eventFilterControl(
  event: string,
  field: AppConfigField,
  buttons?: FrameButton[] | null
): EventFilterControl {
  const known = Array.isArray(buttons) ? buttons.filter((button) => typeof button?.label === 'string') : []
  if (field.options && field.options.length > 0) {
    const labelsByRole = event === 'button' && field.name === 'role' ? roleLabelsByRole(known) : {}
    return {
      kind: 'select',
      options: [ANY_EVENT_FILTER_OPTION, ...field.options.map((option) => contractOption(option, labelsByRole))],
    }
  }
  if (field.type === 'boolean') {
    return {
      kind: 'select',
      options: [ANY_EVENT_FILTER_OPTION, { value: 'true', label: 'yes' }, { value: 'false', label: 'no' }],
    }
  }
  if (event === 'button' && known.length > 0 && (field.name === 'label' || field.name === 'pin')) {
    return {
      kind: 'select',
      options: [
        ANY_EVENT_FILTER_OPTION,
        ...known.map((button) =>
          field.name === 'label'
            ? { value: button.label, label: button.label }
            : { value: String(button.pin), label: `${button.pin} (${button.label})` }
        ),
      ],
    }
  }
  if (field.type === 'integer' || field.type === 'float') {
    return { kind: 'number' }
  }
  return { kind: 'text' }
}
