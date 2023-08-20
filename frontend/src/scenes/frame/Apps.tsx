import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { H6 } from '../../components/H6'
import clsx from 'clsx'
import { appsLogic } from './appsLogic'
import { appsModel } from '../../models/appsModel'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { Form, Group } from 'kea-forms'
import { Button } from '../../components/Button'
import { frameLogic } from './frameLogic'
import { Select } from '../../components/Select'

export interface AppsProps {
  className?: string
  id: number
}

export function Apps({ className }: AppsProps) {
  const { id } = useValues(frameLogic)
  const {
    appsForm: { appsArray },
    isAppsFormValid,
  } = useValues(appsLogic({ id }))
  const { addApp, moveAppUp, moveAppDown, removeApp, saveApps, saveAppsAndDeploy, saveAppsAndRestart } = useActions(
    appsLogic({ id })
  )
  const { apps } = useValues(appsModel)

  return (
    <Box className={clsx('p-4 space-y-8', className)}>
      <Form logic={appsLogic} props={{ id }} formKey="appsForm" className="space-y-4">
        <H6>Apps</H6>
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
                {fields.map(({ name, label, placeholder, type, options }) => (
                  <Field key={name} name={['config', name]} label={label || name}>
                    {type === 'select' ? (
                      <Select placeholder={placeholder} options={options?.map((o) => ({ label: o, value: o })) ?? []} />
                    ) : (
                      <TextInput placeholder={placeholder} />
                    )}
                  </Field>
                ))}
              </Group>
            </Box>
          )
        })}
        {appsArray.length === 0 ? (
          <div className="flex items-center space-x-2 p-2">
            <div className="text-2xl">💡</div>
            <div>Add an app from the list below to make the frame actually display something.</div>
          </div>
        ) : null}
        <div className="flex space-x-4">
          <Button type="button" onClick={saveApps} color={isAppsFormValid ? 'teal' : 'gray'}>
            Save
          </Button>
          <Button type="button" onClick={saveAppsAndRestart} color={isAppsFormValid ? 'teal' : 'gray'}>
            & Restart
          </Button>
          <Button type="button" onClick={saveAppsAndDeploy} color={isAppsFormValid ? 'teal' : 'gray'}>
            & Redeploy
          </Button>
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
