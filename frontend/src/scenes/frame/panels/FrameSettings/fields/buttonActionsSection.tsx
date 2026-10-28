import { PencilSquareIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Button } from '../../../../../components/Button'
import { H6 } from '../../../../../components/H6'
import { Select, type SelectOptionEntry } from '../../../../../components/Select'
import { Tag } from '../../../../../components/Tag'
import type { EventMapRule } from '../../../../../types'
import { cloudFrameSupportsEventMap, eventMapCloudFrameSettingsMinVersion } from '../../../../../utils/cloudFrameSettings'
import {
  type ButtonBinding,
  type FrameActionOffer,
  bindingConflicts,
  deviceEventMap,
  frameActionKindsFor,
  frameActionTitle,
  frameActionUnavailableReason,
  frameActionValue,
  frameBindings,
  frameEventMapRules,
  gestureCanVoiceChat,
  parseFrameActionValue,
  reportedEventMapOf,
} from '../../../../../utils/frameEventMap'
import {
  buttonGestures,
  frameButtons,
  gestureTitle,
  gestureValue,
  parseGestureValue,
} from '../../../../../utils/sceneEventMap'
import { deviceSwitchesDisplay, frameDisplayDevice } from '../../../../workspace/workspaceSurfaces'
import { useFrameSettings } from '../frameSettingsContext'

/**
 * Button actions (frame.json `eventMap`, docs/events.md "Event map"): what a
 * press of one of the frame's buttons does whatever scene is showing. A
 * press bound here never reaches the scene; "Map buttons" on an installed
 * scene is for the presses that do. A cloud frame that reported its map and
 * was never pushed one shows that map (its board preset's), with "Edit
 * actions" seeding the editable list; everything else is the editable list.
 */
export function ButtonActionsSection(): JSX.Element {
  const { frame, frameForm, setFrameFormValues, surface, voiceChat } = useFrameSettings()
  const cloudProfile = surface === 'cloudLinux' || surface === 'cloudEsp32'
  const supported = !cloudProfile || cloudFrameSupportsEventMap(frame.frameos_version)
  const buttons = frameButtons(frame, frameForm)
  const gestures = buttonGestures(buttons)
  const scenes = (frameForm.scenes ?? frame.scenes ?? []).map((scene) => ({ id: scene.id, name: scene.name }))
  const reported = cloudProfile ? reportedEventMapOf(frame.hardware?.eventMap) : null
  const showReported = frameForm.event_map === undefined && reported !== null
  // A frame never given a map runs its device's (a HyperPixel's edge swipes,
  // device_event_map.nim); a cloud frame reports it, a backend frame shows it here.
  const deviceDefault =
    !cloudProfile && frameForm.event_map === undefined && (frame.event_map ?? null) === null
      ? deviceEventMap(frameForm.device ?? frameDisplayDevice(frame))
      : null
  const rules: EventMapRule[] = frameForm.event_map ?? (cloudProfile ? [] : frame.event_map ?? deviceDefault ?? [])
  const { bindings, others } = frameBindings(rules)
  // What this frame can do with a press: Display on / off only where the
  // device switches the panel (not e-paper), Voice chat only on a frame with a
  // microphone, and then for a long press alone.
  const offer: FrameActionOffer = {
    voiceChat: voiceChat !== null,
    displayPower: deviceSwitchesDisplay(frameForm.device ?? frameDisplayDevice(frame)),
  }
  const conflicts = bindingConflicts(bindings, offer)

  const write = (next: readonly ButtonBinding[]): void => {
    setFrameFormValues({ event_map: frameEventMapRules(next, others) })
  }
  const addBinding = (): void => {
    const gesture = gestures.find(
      (candidate) =>
        !bindings.some((b) => b.gesture.label === candidate.label && b.gesture.action === candidate.action)
    ) ??
      gestures[0] ?? { label: buttons[0]?.label ?? 'A', action: 'longPress' }
    write([...bindings, { gesture, action: { kind: 'nextScene' } }])
  }
  const gestureOptions = (binding: ButtonBinding): SelectOptionEntry[] => {
    const byButton = new Map<string, { value: string; label: string }[]>()
    for (const gesture of gestures) {
      const entry = { value: gestureValue(gesture), label: gestureTitle(gesture) }
      byButton.set(gesture.label, [...(byButton.get(gesture.label) ?? []), entry])
    }
    // A binding for a button this frame no longer has stays selectable, so
    // the row shows what is saved instead of silently picking the first entry.
    const stale = gestures.some(
      (gesture) => gesture.label === binding.gesture.label && gesture.action === binding.gesture.action
    )
      ? []
      : [{ value: gestureValue(binding.gesture), label: `${gestureTitle(binding.gesture)} (not on this frame)` }]
    return [...stale, ...Array.from(byButton, ([label, options]) => ({ label, options }))]
  }
  const actionOptions = (binding: ButtonBinding): SelectOptionEntry[] => [
    // A saved action the row would not offer stays selectable, named with
    // why, so the row shows what is saved instead of picking the first entry.
    ...(frameActionUnavailableReason(binding, offer)
      ? [
          {
            value: frameActionValue(binding.action),
            label: `${frameActionTitle(binding.action)} (${frameActionUnavailableReason(binding, offer)})`,
          },
        ]
      : []),
    ...frameActionKindsFor(binding.gesture, offer).map((kind) => ({
      value: frameActionValue({ kind }),
      label: frameActionTitle({ kind }),
    })),
    // On a frame with voice chat, a press or a double press shows why it
    // cannot carry it rather than leaving the entry out.
    ...(offer.voiceChat && !gestureCanVoiceChat(binding.gesture) && binding.action.kind !== 'voiceChat'
      ? [{ value: frameActionValue({ kind: 'voiceChat' }), label: 'Voice chat (long press only)', disabled: true }]
      : []),
    ...(scenes.length > 0
      ? [
          {
            label: 'Show scene',
            options: scenes.map((scene) => ({
              value: frameActionValue({ kind: 'showScene', sceneId: scene.id }),
              label: frameActionTitle({ kind: 'showScene', sceneId: scene.id }, scenes),
            })),
          },
        ]
      : []),
  ]
  const describe = (rule: EventMapRule): string =>
    `${rule.event}${rule.match ? ' ' + JSON.stringify(rule.match) : ''} ${rule.emit ? `emits ${rule.emit}` : 'rewritten'} ${JSON.stringify(rule.as)}`

  const addButton = (
    <Button size="small" color="secondary" onClick={addBinding} className="flex items-center gap-1" disabled={!supported}>
      <PlusIcon className="w-4 h-4" />
      Add action
    </Button>
  )

  return (
    <>
      <H6 id="frame-settings-button-actions" className="flex items-center gap-2">
        Button actions
        {showReported ? (
          <>
            <Tag color="gray">On the frame</Tag>
            {supported ? (
              <Button
                size="small"
                color="secondary"
                onClick={() => setFrameFormValues({ event_map: reported.map((rule) => ({ ...rule })) })}
                className="flex items-center gap-1"
              >
                <PencilSquareIcon className="w-4 h-4" />
                Edit actions
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {deviceDefault ? <Tag color="gray">Device default</Tag> : null}
            {addButton}
          </>
        )}
      </H6>
      <div className="pl-2 @md:pl-8 space-y-2">
        {!supported ? (
          <p className="frameos-muted text-xs">
            {frame.frameos_version
              ? `Button actions need FrameOS ${eventMapCloudFrameSettingsMinVersion} or newer on the frame (this one reports ${frame.frameos_version}). Update the frame to edit them here.`
              : `Button actions need FrameOS ${eventMapCloudFrameSettingsMinVersion} or newer on the frame. They unlock once the frame connects and reports its version.`}
          </p>
        ) : null}
        <p className="frameos-muted text-xs">
          What a press does on this frame, whatever scene is showing. A press bound here never reaches the scene;
          a scene&apos;s own buttons are mapped from its menu, under Map buttons.
          {offer.voiceChat
            ? ' Voice chat goes on a long press: the frame listens while the key is held and stops when it is let go, so a press or a double press has no end to it.'
            : ''}
        </p>
        {showReported ? (
          reported.length > 0 ? (
            <>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {frameBindings(reported).bindings.map((binding, index) => (
                  <li key={index}>
                    {gestureTitle(binding.gesture)}: {frameActionTitle(binding.action, scenes)}
                  </li>
                ))}
                {frameBindings(reported).others.map((rule, index) => (
                  <li key={`other-${index}`} className="font-mono text-xs">
                    {describe(rule)}
                  </li>
                ))}
              </ul>
              <p className="frameos-muted text-xs">
                The actions the frame runs with, from its board preset. Edit actions starts from this list; saving
                pushes the new list.
              </p>
            </>
          ) : (
            <p className="frameos-muted text-xs">No button actions on the frame.</p>
          )
        ) : (
          <>
            {bindings.map((binding, index) => (
              <div
                key={index}
                className="grid grid-cols-1 items-center gap-2 @md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]"
              >
                <Select
                  name={`event_map.${index}.gesture`}
                  value={gestureValue(binding.gesture)}
                  options={gestureOptions(binding)}
                  disabled={!supported}
                  onChange={(value) => {
                    const gesture = parseGestureValue(value)
                    if (gesture) {
                      write(bindings.map((b, i) => (i === index ? { ...b, gesture } : b)))
                    }
                  }}
                />
                <span className="frameos-muted text-sm">does</span>
                <Select
                  name={`event_map.${index}.action`}
                  value={frameActionValue(binding.action)}
                  options={actionOptions(binding)}
                  disabled={!supported}
                  onChange={(value) => {
                    const action = parseFrameActionValue(value)
                    if (action) {
                      write(bindings.map((b, i) => (i === index ? { ...b, action } : b)))
                    }
                  }}
                />
                <Button
                  color="secondary"
                  size="small"
                  className="flex items-center gap-1"
                  disabled={!supported}
                  onClick={() => write(bindings.filter((_b, i) => i !== index))}
                >
                  <TrashIcon className="w-4 h-4" />
                  Remove
                </Button>
              </div>
            ))}
            {bindings.length === 0 && others.length === 0 ? (
              <p className="frameos-muted text-xs">No button actions. Every press reaches the scene.</p>
            ) : null}
            {conflicts.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
                {conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}</li>
                ))}
              </ul>
            ) : null}
            {others.length > 0 ? (
              <div className="space-y-1">
                <p className="frameos-muted text-xs">Rules written by hand, kept as they are:</p>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {others.map((rule, index) => (
                    <li key={index}>{describe(rule)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {buttons.length === 0 ? (
              <p className="frameos-muted text-xs">
                This frame has no buttons yet; add them under GPIO buttons and the presses appear here.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
