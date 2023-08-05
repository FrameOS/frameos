import { actions, kea, path, reducers } from 'kea'
import { actionToUrl, urlToAction } from 'kea-router'

import type { framesLogicType } from './framesLogicType'

export const framesLogic = kea<framesLogicType>([
  path(['src', 'frames', 'framesLogic']),
  actions({
    setCount: (count: number) => ({ count }),
  }),
  reducers({
    count: [
      0,
      {
        setCount: (_, { count }) => count,
      },
    ],
  }),
  actionToUrl({
    setCount: ({ count }) => (count === 0 ? '/' : `/${count}`),
  }),
  urlToAction(({ actions, values }) => ({
    '/(:count)': ({ count }) => {
      const newCount = parseInt(count || '0')
      if (values.count !== newCount) {
        actions.setCount(newCount)
      }
    },
  })),
])
