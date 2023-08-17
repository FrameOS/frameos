import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { framesModel } from '../../models/framesModel'

import type { frameLogicType } from './frameLogicType'
import { forms } from 'kea-forms'
import { FrameApp, FrameType } from '../../types'
import { appsModel } from '../../models/appsModel'

export interface FrameLogicProps {
  id: number
}

export const frameLogic = kea<frameLogicType>([
  path(['src', 'scenes', 'frame', 'frameLogic']),
  props({} as FrameLogicProps),
  key((props) => props.id),
  actions({
    editFrame: (frame: FrameType) => ({ frame }),
    closeEdit: true,
    addApp: (keyword: string) => ({ keyword }),
    removeApp: (index: number) => ({ index }),
    moveAppDown: (index: number) => ({ index }),
    moveAppUp: (index: number) => ({ index }),
  }),
  selectors(() => ({
    id: [() => [(_, props) => props.id], (id) => id],
    frame: [(s) => [framesModel.selectors.frames, s.id], (frames, id) => frames[id] || null],
  })),
  forms(({ actions, values }) => ({
    appsForm: {
      options: {
        showErrorsOnTouch: true,
      },
      defaults: { appsArray: [] as FrameApp[] },
      submit: async (formValues, breakpoint) => {
        const formData = new FormData()
        formData.append('apps', JSON.stringify(formValues.appsArray))
        const response = await fetch(`/api/frames/${values.id}/update_apps`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Failed to submit frame')
        }
      },
      errors: ({ appsArray }: { appsArray: FrameApp[] }) => {
        const newArray: Partial<FrameApp>[] = appsArray.map((frameApp) => {
          const app = appsModel.values.apps[frameApp.keyword]
          return {
            config: Object.fromEntries(
              app.fields
                ?.filter(({ name, required }) => required && !frameApp.config[name])
                .map(({ name }) => [name, 'This field is required'])
            ),
          }
        })
        return {
          appsArray: newArray,
        }
      },
    },
    editFrame: {
      defaults: {} as any as FrameType,
      submit: async (frame) => {
        try {
          const formData = new FormData()
          Object.keys(frame).forEach((key) => {
            const value = (frame as any)[key]
            formData.append(key, value === null || value === undefined ? '' : value)
          })
          const response = await fetch(`/api/frames/${values.id}/update`, {
            method: 'POST',
            body: formData,
          })
          if (!response.ok) {
            throw new Error('Failed to submit frame')
          }
          actions.resetEditFrame()
          actions.closeEdit()
        } catch (error) {
          console.error(error)
        }
      },
    },
  })),
  reducers({
    editing: [false, { editFrame: () => true, closeEdit: () => false }],
    appsForm: [
      { appsArray: [] as FrameApp[] },
      {
        removeApp: ({ appsArray }, { index }) => ({ appsArray: appsArray.filter((_, i) => i !== index) }),
        moveAppDown: ({ appsArray }, { index }) => {
          const newArray = [...appsArray]
          if (index < newArray.length - 1) {
            const tmp = newArray[index]
            newArray[index] = newArray[index + 1]
            newArray[index + 1] = tmp
          }
          return { appsArray: newArray }
        },
        moveAppUp: ({ appsArray }, { index }) => {
          const newArray = [...appsArray]
          if (index > 0) {
            const tmp = newArray[index]
            newArray[index] = newArray[index - 1]
            newArray[index - 1] = tmp
          }
          return { appsArray: newArray }
        },
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    editFrame: async ({ frame }) => {
      actions.resetEditFrame()
      actions.setEditFrameValues({
        frame_host: frame.frame_host,
        frame_port: frame.frame_port,
        ssh_user: frame.ssh_user,
        ssh_pass: frame.ssh_pass,
        ssh_port: frame.ssh_port,
        server_host: frame.server_host,
        server_port: frame.server_port,
        server_api_key: frame.server_api_key,
        image_url: frame.image_url,
        interval: frame.interval,
      })
    },
    addApp: ({ keyword }) => {
      const { apps } = appsModel.values
      const app = apps[keyword]
      const frameApp: FrameApp = {
        keyword: keyword,
        name: app.name,
        description: app.description,
        version: app.version,
        fields: app.fields,
        config: Object.fromEntries(
          app.fields
            .filter(({ name, required, value }) => !!required || value !== undefined)
            .map(({ name, value }) => [name, value])
        ),
      }
      actions.setAppsFormValue('appsArray', [...values.appsForm.appsArray, frameApp])
    },
  })),
])
