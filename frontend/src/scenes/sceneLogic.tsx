import { actions, kea, listeners, path, reducers } from 'kea'

import type { sceneLogicType } from './sceneLogicType'
import { urlToAction } from 'kea-router'
import { getRoutes } from './scenes'
import { getBasePath } from '../utils/getBasePath'
import { urls } from '../urls'
import { inHassioIngress } from '../utils/inHassioIngress'
import { clearCachedProjectId } from '../utils/projectApi'

// Note: this should not connect to any other logic that pulls in data, as it's used even when the user is not logged in
export const sceneLogic = kea<sceneLogicType>([
  path(['src', 'sceneLogic']),
  actions({
    setScene: (scene, params) => ({ scene, params }),
    logout: true,
  }),
  reducers(() => ({
    basePath: [getBasePath(), {}],
    isHassioIngress: [inHassioIngress(), {}],
    scene: [
      null as string | null,
      {
        setScene: (_, payload) => payload.scene,
      },
    ],
    params: [
      {},
      {
        setScene: (_, payload) => payload.params || {},
      },
    ],
  })),
  urlToAction(({ actions }) => {
    return Object.fromEntries(
      Object.entries(getRoutes()).map(([path, scene]) => {
        return [path, (params) => actions.setScene(scene, params)]
      })
    )
  }),
  listeners(({ actions }) => ({
    logout: async () => {
      let cloudLogoutUrl: string | null = null
      try {
        const response = await fetch(`${getBasePath()}/api/logout`, { method: 'POST' })
        if (response.ok) {
          cloudLogoutUrl = (await response.json())?.cloud_logout_url ?? null
        }
      } catch (error) {
        console.error('Logout failed', error)
      }
      clearCachedProjectId()
      if (cloudLogoutUrl) {
        // Cloud-login users must also leave their FrameOS Cloud session, or
        // the login screen's cloud button would sign them straight back in.
        // The cloud bounces back to our /login page.
        location.href = cloudLogoutUrl
        return
      }
      location.href = urls.frames()
    },
  })),
])
