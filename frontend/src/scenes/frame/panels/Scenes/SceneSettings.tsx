import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSettingsLogic } from './sceneSettingsLogic'
import { Form, Group } from 'kea-forms'
import { Field } from '../../../../components/Field'
import { TextInput } from '../../../../components/TextInput'
import { panelsLogic } from '../panelsLogic'
import { H6 } from '../../../../components/H6'
import { NumberTextInput } from '../../../../components/NumberTextInput'

export interface SceneSettingsProps {
  sceneId: string
}

export function SceneSettings({ sceneId }: SceneSettingsProps): JSX.Element {
  const { frameId, frameForm } = useValues(frameLogic)
  const { sceneIndex, scene } = useValues(sceneSettingsLogic({ frameId, sceneId }))
  if (!scene || !sceneId) {
    return <></>
  }

  return (
    <Form logic={frameLogic} props={{ frameId }} formKey="frameForm">
      <Group name={['scenes', sceneIndex]}>
        <div className="w-full space-y-1">
          <Group name={['settings']}>
            <Field
              className="flex flex-row gap-2 w-full justify-between"
              name="refreshInterval"
              label="Refresh interval in seconds"
              tooltip={
                <>
                  How often do we trigger a refresh, in seconds. Pass a large number like "60" or even more for e-ink
                  frames. A number below 1 activates realtime mode (0.041s = 24fps, 0.016s = 60fps). This should be used
                  when you're certain of your setup and only if your hardware supports it.
                </>
              }
            >
              <NumberTextInput
                name="refreshInterval"
                placeholder={String(frameForm.interval || 300)}
                style={{ width: 70 }}
              />
            </Field>
            <Field
              className="flex flex-row gap-2 w-full justify-between"
              name="backgroundColor"
              label="Background color"
            >
              <TextInput
                type="color"
                name="backgroundColor"
                className="!p-0"
                style={{ width: 70 }}
                placeholder="#ffffff"
              />
            </Field>
          </Group>
        </div>
      </Group>
    </Form>
  )
}

SceneSettings.PanelTitle = function SceneSettingsPanelTitle() {
  return <>Scene Settings</>
}
