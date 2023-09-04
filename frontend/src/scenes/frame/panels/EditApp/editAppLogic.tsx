import { actions, kea, path, reducers } from 'kea'

import type { editAppLogicType } from './editAppLogicType'

export const editAppLogic = kea<editAppLogicType>([
  path(['src', 'scenes', 'frame', 'panels', 'EditApp', 'editAppLogic']),
  actions({ editApp: (keyword: string) => ({ keyword }) }),
  reducers({
    editingApps: [
      {} as Record<string, boolean>,
      {
        editApp: (state, { keyword }) => ({ ...state, [keyword]: true }),
      },
    ],
  }),
])
