import { Cog6ToothIcon } from '@heroicons/react/24/outline'
import { useActions, useValues } from 'kea'
import type { FormEvent, ReactNode } from 'react'

import { Modal } from '../../components/Modal'
import type { FrameScene, StateField } from '../../types'
import { frameLayoutChoice, NO_FLASH_LAYOUT, starterLayoutChoice } from '../../utils/flashLayout'
import { StateFieldEdit } from '../frame/panels/Scenes/StateFieldEdit'
import { FLASH_LAYOUT_STARTER_GROUPS, flashLayoutLogic } from './flashLayoutLogic'

/**
 * The layout a frame starts with, chosen where its card or board is flashed
 * (docs/scene-layouts.md "Chosen at the flash"): "No layout", the frame's own
 * layouts, the starters, and a gear for the chosen layout's settings. Every
 * flow that flashes a frame shows this one; what the choice does is its
 * logic's (flashLayoutLogic).
 */
export function FlashLayoutPicker({
  pickerKey,
  frameScenes,
  hint,
  className,
  labelClassName,
}: {
  pickerKey: string
  /** The frame's scenes when the frame exists: its layouts are offered, the one it wears is selected. */
  frameScenes?: FrameScene[] | null
  hint?: ReactNode
  className?: string
  /** The label's look, to match the form around it. */
  labelClassName?: string
}): JSX.Element {
  const logic = flashLayoutLogic({ pickerKey, frameScenes })
  const { value, frameLayoutGroups, chosenScene, fields, settingsOpen, draftFields, draftState, error } =
    useValues(logic)
  const { setChoice, openSettings, closeSettings, setDraftValue, saveSettings } = useActions(logic)
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    saveSettings()
  }
  return (
    <div className={className ?? 'space-y-1'} data-flash-layout-picker={pickerKey}>
      <div className="space-y-1">
        <div className={labelClassName ?? 'frameos-form-label text-sm font-semibold'}>Layout</div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Layout"
            value={value}
            onChange={(event) => setChoice(event.target.value)}
            className="frameos-form-control h-11 w-full min-w-0 rounded-xl border px-3 text-sm outline-none focus:ring-2 focus:ring-blue-400/30"
          >
            <option value={NO_FLASH_LAYOUT}>No layout</option>
            {frameLayoutGroups.map((group) => (
              <optgroup key={`frame-${group.kind}`} label={`On this frame: ${group.title.toLowerCase()}`}>
                {(group.items as FrameScene[]).map((layout) => (
                  <option key={layout.id} value={frameLayoutChoice(layout.id)}>
                    {layout.name || 'Untitled layout'}
                  </option>
                ))}
              </optgroup>
            ))}
            {FLASH_LAYOUT_STARTER_GROUPS.map((group) => (
              <optgroup key={`starter-${group.kind}`} label={group.title}>
                {group.items.map((starter) => (
                  <option key={starter.name} value={starterLayoutChoice(starter.name)} title={starter.description}>
                    {starter.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {chosenScene && fields.length > 0 ? (
            <button
              type="button"
              title="Layout settings"
              aria-label="Layout settings"
              onClick={openSettings}
              className="frameos-secondary-button flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            >
              <Cog6ToothIcon className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="frameos-muted text-xs">
        {hint ?? 'Drawn around every scene on the frame, and around the scenes you install on it later.'}
      </div>
      {error ? <div className="text-xs font-semibold text-red-500">{error}</div> : null}
      {settingsOpen && chosenScene ? (
        <Modal open onClose={closeSettings} title={`Layout settings: ${chosenScene.name || 'Untitled layout'}`}>
          <form onSubmit={handleSubmit} className="space-y-4 p-5">
            {draftFields.length === 0 ? (
              <p className="frameos-muted text-sm">This layout has no settings to change.</p>
            ) : (
              <div className="space-y-3">
                {(draftFields as StateField[]).map((field) => (
                  <div key={field.name} className="space-y-1">
                    <label className="frameos-muted text-sm font-semibold">{field.label || field.name}</label>
                    <StateFieldEdit
                      field={field}
                      value={draftState[field.name] ?? field.value ?? ''}
                      onChange={(next) => setDraftValue(field, next)}
                      currentState={{}}
                      stateChanges={draftState}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeSettings}
                className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                Apply
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
