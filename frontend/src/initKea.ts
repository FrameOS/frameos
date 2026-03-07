import './index.css'
import { resetContext } from 'kea'
import { subscriptionsPlugin } from 'kea-subscriptions'
import { localStoragePlugin } from 'kea-localstorage'
import { loadersPlugin } from 'kea-loaders'
import { routerPlugin } from 'kea-router'

export function initKea() {
  resetContext({
    plugins: [
      routerPlugin(),
      subscriptionsPlugin,
      localStoragePlugin(),
      loadersPlugin({
        onFailure({ error, reducerKey, actionKey }: { error: any; reducerKey: string; actionKey: string }) {
          console.error({ error, reducerKey, actionKey })
        },
      }),
    ],
  })
}
