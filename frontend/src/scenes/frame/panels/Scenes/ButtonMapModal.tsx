import { useActions, useValues } from 'kea'
import type { FormEvent } from 'react'

import { PlusIcon, TrashIcon } from '@heroicons/react/24/solid'

import { Button } from '../../../../components/Button'
import { Modal } from '../../../../components/Modal'
import { Select, type SelectOptionEntry } from '../../../../components/Select'
import type { FrameId } from '../../../../types'
import {
  type ButtonListener,
  buttonsHeardAsIs,
  gestureTitle,
  gestureValue,
  parseGestureValue,
} from '../../../../utils/sceneEventMap'
import {
  type ButtonBinding,
  frameActionKindsFor,
  frameActionTitle,
  frameActionUnavailableReason,
  frameActionValue,
  frameGestureTitle,
  frameGestureValue,
  parseFrameActionValue,
  parseFrameGestureValue,
} from '../../../../utils/frameEventMap'
import { buttonMapLogic } from './buttonMapLogic'

/**
 * "Map buttons" for one installed scene: one row per `button` listener the
 * scene has, each with the press of one of the frame's buttons it answers to.
 * On a frame with an accelerometer, a motion of the frame (a flick, a tilt, a
 * shake) can do something while this scene shows, as Forward turns a reader's
 * page (docs/accelerometer.md). Saving writes the scene's `eventMap` into the
 * frame form; the frame's own Save pushes it (docs/events.md, "Event map").
 */
export function ButtonMapModal({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element | null {
  const logic = buttonMapLogic({ frameId, sceneId })
  const {
    isOpen,
    scene,
    buttons,
    listeners,
    gestures,
    choices,
    custom,
    conflicts,
    changed,
    motionBindings,
    motionGestures,
    motionOffer,
  } = useValues(logic)
  const { closeButtonMap, setChoice, saveButtonMap, addMotionBinding, setMotionBinding, removeMotionBinding } =
    useActions(logic)

  if (!isOpen || !scene) {
    return null
  }

  const canSave = changed && conflicts.length === 0
  const motion = motionGestures.length > 0 || motionBindings.length > 0

  const motionGestureOptions = (binding: ButtonBinding): SelectOptionEntry[] => {
    const value = frameGestureValue(binding.gesture)
    const stale = motionGestures.some((gesture) => frameGestureValue(gesture) === value)
      ? []
      : [{ value, label: `${frameGestureTitle(binding.gesture)} (not on this frame)` }]
    return [
      ...stale,
      ...motionGestures.map((gesture) => ({ value: frameGestureValue(gesture), label: frameGestureTitle(gesture) })),
    ]
  }
  const motionActionOptions = (binding: ButtonBinding): SelectOptionEntry[] => {
    const why = frameActionUnavailableReason(binding, motionOffer)
    return [
      ...(why
        ? [{ value: frameActionValue(binding.action), label: `${frameActionTitle(binding.action)} (${why})` }]
        : []),
      ...frameActionKindsFor(binding.gesture, motionOffer).map((kind) => ({
        value: frameActionValue({ kind }),
        label: frameActionTitle({ kind }),
      })),
    ]
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (canSave) {
      saveButtonMap()
    }
  }

  const optionsFor = (listener: ButtonListener): SelectOptionEntry[] => {
    const asIs = buttonsHeardAsIs(listener, buttons)
    const asIsLabel = asIs.length
      ? `As is (${asIs.map((button) => button.label).join(', ')})`
      : buttons.length
        ? 'As is (no button on this frame)'
        : 'As is'
    const byButton = new Map<string, { value: string; label: string }[]>()
    for (const gesture of gestures) {
      const entry = { value: gestureValue(gesture), label: gestureTitle(gesture) }
      byButton.set(gesture.label, [...(byButton.get(gesture.label) ?? []), entry])
    }
    // A choice the frame no longer has a button for stays selectable, so the
    // dialog shows what is saved instead of silently picking the first entry.
    const chosen = parseGestureValue(choices[listener.key] ?? '')
    const stale =
      chosen && !gestures.some((gesture) => gesture.label === chosen.label && gesture.action === chosen.action)
        ? [{ value: gestureValue(chosen), label: `${gestureTitle(chosen)} (not on this frame)` }]
        : []
    return [
      { value: '', label: asIsLabel },
      ...stale,
      ...Array.from(byButton, ([label, options]) => ({ label, options })),
    ]
  }

  return (
    <Modal open onClose={closeButtonMap} title={`Map buttons: ${scene.name}`}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        {listeners.length === 0 ? (
          <p className="frameos-muted text-sm">
            This scene has no button listener that names a button (a label, a role or a pin), so there is nothing to
            map. A listener that filters on nothing hears every button.
          </p>
        ) : null}
        {listeners.length > 0 ? (
          <>
            <p className="frameos-muted text-sm">
              The scene listens for the buttons on the left. Pick which press of which of this frame&apos;s buttons each
              one answers to.{' '}
              {buttons.length === 0 ? 'This frame has no buttons configured yet (Settings → Buttons).' : ''}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="frameos-muted text-left text-xs uppercase tracking-wide">
                  <th className="py-1 pr-3 font-semibold">Scene listens for</th>
                  <th className="py-1 font-semibold">This frame</th>
                </tr>
              </thead>
              <tbody>
                {listeners.map((listener) => (
                  <tr key={listener.key}>
                    <td className="py-1 pr-3 align-middle font-medium">{listener.title}</td>
                    <td className="py-1">
                      <Select
                        value={choices[listener.key] ?? ''}
                        onChange={(value) => setChoice(listener.key, value)}
                        options={optionsFor(listener)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
        {motion ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold">Moving the frame</p>
            <p className="frameos-muted text-sm">
              What a flick, a tilt or a shake of the frame does while this scene shows: a flick to the right as Forward
              turns a reader&apos;s page. The scene no longer hears a motion bound here.
            </p>
            {motionBindings.map((binding, index) => (
              <div
                key={index}
                className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]"
              >
                <Select
                  value={frameGestureValue(binding.gesture)}
                  options={motionGestureOptions(binding)}
                  onChange={(value) => {
                    const gesture = parseFrameGestureValue(value)
                    if (gesture) {
                      setMotionBinding(index, { ...binding, gesture })
                    }
                  }}
                />
                <span className="frameos-muted text-sm">does</span>
                <Select
                  value={frameActionValue(binding.action)}
                  options={motionActionOptions(binding)}
                  onChange={(value) => {
                    const action = parseFrameActionValue(value)
                    if (action) {
                      setMotionBinding(index, { ...binding, action })
                    }
                  }}
                />
                <Button
                  color="secondary"
                  size="small"
                  className="flex items-center gap-1"
                  onClick={() => removeMotionBinding(index)}
                >
                  <TrashIcon className="w-4 h-4" />
                  Remove
                </Button>
              </div>
            ))}
            {motionGestures.length > 0 ? (
              <Button size="small" color="secondary" className="flex items-center gap-1" onClick={addMotionBinding}>
                <PlusIcon className="w-4 h-4" />
                Add motion
              </Button>
            ) : null}
          </div>
        ) : null}
        {listeners.length > 0 || motion ? (
          <>
            {conflicts.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-600 dark:text-amber-400">
                {conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}. A press can only mean one thing.</li>
                ))}
              </ul>
            ) : null}
            {custom.length > 0 ? (
              <p className="frameos-muted text-xs">
                {custom.length === 1 ? 'One rule' : `${custom.length} rules`} written by hand in this scene&apos;s event
                map {custom.length === 1 ? 'is' : 'are'} kept as {custom.length === 1 ? 'it is' : 'they are'}.
              </p>
            ) : null}
            <p className="frameos-muted text-xs">
              The map belongs to this installed scene, not to the scene itself: updating the scene keeps it. Save the
              frame to push it.
            </p>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeButtonMap}
            className="frameos-secondary-button rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Cancel
          </button>
          {listeners.length > 0 || motion ? (
            <button
              type="submit"
              disabled={!canSave}
              className="frameos-primary-action rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  )
}
