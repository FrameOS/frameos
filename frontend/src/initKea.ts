import './index.css'
import { resetContext } from 'kea'
import { subscriptionsPlugin } from 'kea-subscriptions'
import { localStoragePlugin } from 'kea-localstorage'
import { loadersPlugin } from 'kea-loaders'
import { routerPlugin } from 'kea-router'
import { hassioIngressParentRouterOptions, installHassioIngressParentRouter } from './utils/hassioIngressParentRouter'
import { memoryRouterOptions } from './utils/memoryRouter'

export interface InitKeaOptions {
  /** Embedded builds (the editor library, the direct mount, the iframe
   * bundle): route in memory, never touching the host page's URL. */
  memoryRouter?: boolean
}

export function initKea(options: InitKeaOptions = {}) {
  resetContext({
    plugins: [
      routerPlugin(options.memoryRouter ? memoryRouterOptions() : hassioIngressParentRouterOptions()),
      subscriptionsPlugin,
      localStoragePlugin(),
      loadersPlugin({
        onFailure({ error, reducerKey, actionKey }: { error: any; reducerKey: string; actionKey: string }) {
          console.error({ error, reducerKey, actionKey })
        },
      }),
    ],
  })
  if (!options.memoryRouter) {
    installHassioIngressParentRouter()
  }
}
