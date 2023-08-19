import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import clsx from 'clsx'
import { frameLogic } from './frameLogic'
import { appsModel } from '../../models/appsModel'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { Form, Group } from 'kea-forms'
import { Button } from '../../components/Button'

export interface AppsProps {
  className?: string
  id: number
}

export function Apps({ className }: AppsProps) {
  const {
    appsForm: { appsArray },
    isAppsFormValid,
  } = useValues(frameLogic)
  const { addApp, moveAppUp, moveAppDown, removeApp, saveApps, saveAppsAndDeploy, saveAppsAndRestart } =
    useActions(frameLogic)
  const { apps } = useValues(appsModel)

  return (
    <Box className={clsx('p-4 space-y-8', className)}>
      <Form logic={frameLogic} formKey="appsForm" className="space-y-4">
        <H6>Apps that run each frame</H6>
        <div className="space-y-2">
          {appsArray.map(({ fields, keyword, name, description }, index) => {
            const app = apps[keyword]
            return (
              <Box className="bg-gray-900 p-4 space-y-4">
                <Group key={keyword} name={['appsArray', index]}>
                  <div className="flex items-start justify-between">
                    <div>
                      <H6>{name}</H6>
                      <div className="text-sm">{description}</div>
                    </div>
                    <div className="flex space-x-1">
                      <Button size="small" color="gray" onClick={() => moveAppUp(index)} disabled={index === 0}>
                        ⬆
                      </Button>
                      <Button
                        size="small"
                        color="gray"
                        onClick={() => moveAppDown(index)}
                        disabled={index === appsArray.length - 1}
                      >
                        ⬇
                      </Button>
                      <Button size="small" color="gray" onClick={() => removeApp(index)}>
                        ❌
                      </Button>
                    </div>
                  </div>
                  {fields.map(({ name, label, placeholder }) => (
                    <Field key={name} name={['config', name]} label={label || name}>
                      <TextInput placeholder={placeholder} />
                    </Field>
                  ))}
                </Group>
              </Box>
            )
          })}
          {appsArray.length === 0 ? <div className="text-red-400">No apps enabled. Add one from below</div> : null}
          <div className="flex space-x-2">
            <Button type="button" onClick={saveApps} color={isAppsFormValid ? 'blue' : 'gray'}>
              Save
            </Button>
            <Button type="button" onClick={saveAppsAndRestart} color={isAppsFormValid ? 'blue' : 'gray'}>
              Save & Restart
            </Button>
            <Button type="button" onClick={saveAppsAndDeploy} color={isAppsFormValid ? 'blue' : 'gray'}>
              Save & Redeploy
            </Button>
          </div>
        </div>
      </Form>
      <div className="space-y-2">
        <H6>Add apps</H6>
        {Object.entries(apps).map(([keyword, { name, description }]) => (
          <Box className="bg-gray-900 px-3 py-2 flex items-center justify-between">
            <div>
              <H6>{name}</H6>
              <div className="text-sm">{description}</div>
            </div>
            <div>
              <Button onClick={() => addApp(keyword)}>Add</Button>
            </div>
          </Box>
        ))}
      </div>
    </Box>
  )
}
