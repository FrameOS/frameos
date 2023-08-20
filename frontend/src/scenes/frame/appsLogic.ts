import { actions, kea, key, listeners, path, props, reducers, selectors } from 'kea'
import { subscriptions } from 'kea-subscriptions'
import { framesModel } from '../../models/framesModel'

import { forms } from 'kea-forms'
import { AppConfig } from '../../types'
import { appsModel } from '../../models/appsModel'

import type { appsLogicType } from './appsLogicType'

export interface AppsLogicProps {
  id: number
}

export const appsLogic = kea<appsLogicType>([
  path(['src', 'scenes', 'frame', 'appsLogic']),
  props({} as AppsLogicProps),
  key((props) => props.id),
  actions({
    addApp: (keyword: string) => ({ keyword }),
    removeApp: (index: number) => ({ index }),
    moveAppDown: (index: number) => ({ index }),
    moveAppUp: (index: number) => ({ index }),
    saveApps: true,
    saveAppsAndDeploy: true,
    saveAppsAndRestart: true,
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
      defaults: { appsArray: [] as AppConfig[] },
      submit: async (formValues, breakpoint) => {
        const formData = new FormData()
        formData.append('apps', JSON.stringify(formValues.appsArray))
        formData.append('next_action', values.lastAppsSaveButtonPressed)
        const response = await fetch(`/api/frames/${values.id}/update_apps`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          throw new Error('Failed to submit frame')
        }
      },
      errors: ({ appsArray }: { appsArray: AppConfig[] }) => {
        const newArray: Partial<AppConfig>[] = appsArray.map((AppConfig) => {
          const app = appsModel.values.apps[AppConfig.keyword]
          return {
            config: Object.fromEntries(
              app.fields
                ?.filter(({ name, required }) => required && !AppConfig.config[name])
                .map(({ name }) => [name, 'This field is required'])
            ),
          }
        })
        return {
          appsArray: newArray,
        }
      },
    },
  })),
  reducers({
    appsForm: [
      { appsArray: [] as AppConfig[] },
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
    lastAppsSaveButtonPressed: [
      'save',
      {
        saveApps: () => 'save',
        saveAppsAndDeploy: () => 'deploy',
        saveAppsAndRestart: () => 'restart',
      },
    ],
  }),
  listeners(({ actions, values }) => ({
    addApp: ({ keyword }) => {
      const { apps } = appsModel.values
      const app = apps[keyword]
      const AppConfig: AppConfig = {
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
      actions.setAppsFormValue('appsArray', [...values.appsForm.appsArray, AppConfig])
    },
    saveApps: () => {
      actions.submitAppsForm()
    },
    saveAppsAndDeploy: () => {
      actions.submitAppsForm()
    },
    saveAppsAndRestart: () => {
      actions.submitAppsForm()
    },
  })),
  subscriptions(({ actions }) => ({
    frame: (value, oldValue) => {
      if (value && JSON.stringify(value.apps) !== JSON.stringify(oldValue?.apps)) {
        actions.setAppsFormValue('appsArray', value.apps)
      }
    },
  })),
])
