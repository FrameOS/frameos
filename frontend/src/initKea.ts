import ReactDOM from 'react-dom/client'
import { App } from './scenes/App'
import './index.css'
import { resetContext } from 'kea'
import { subscriptionsPlugin } from 'kea-subscriptions'
import { localStoragePlugin } from 'kea-localstorage'
import { loadersPlugin } from 'kea-loaders'
import { error as messgError } from 'messg'
import { routerPlugin } from 'kea-router'

export function capitalizeFirstLetter(string: string): string {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

export function identifierToHuman(identifier: string | number, caseType: 'sentence' | 'title' = 'sentence'): string {
  const words: string[] = []
  let currentWord: string = ''
  String(identifier)
    .trim()
    .split('')
    .forEach((character) => {
      if (character === '_' || character === '-' || character === '/') {
        if (currentWord) {
          words.push(currentWord)
        }
        currentWord = ''
      } else if (
        character === character.toLowerCase() &&
        (!'0123456789'.includes(character) ||
          (currentWord && '0123456789'.includes(currentWord[currentWord.length - 1])))
      ) {
        currentWord += character
      } else {
        if (currentWord) {
          words.push(currentWord)
        }
        currentWord = character.toLowerCase()
      }
    })
  if (currentWord) {
    words.push(currentWord)
  }
  return capitalizeFirstLetter(
    words.map((word) => (caseType === 'sentence' ? word : capitalizeFirstLetter(word))).join(' ')
  )
}

export function initKea() {
  resetContext({
    plugins: [
      routerPlugin(),
      subscriptionsPlugin,
      localStoragePlugin(),
      loadersPlugin({
        onFailure({ error, reducerKey, actionKey }: { error: any; reducerKey: string; actionKey: string }) {
          debugger
          const isLoadAction = typeof actionKey === 'string' && /^(load|get|fetch)[A-Z]/.test(actionKey)
          if (
            error?.status !== undefined &&
            !(isLoadAction && error.status === 403) // 403 access denied is handled by sceneLogic
          ) {
            let errorMessage = error.detail || error.statusText

            if (!errorMessage && error.status === 404) {
              errorMessage = 'URL not found'
            }
            if (errorMessage) {
              messgError(`${identifierToHuman(actionKey)} failed: ${errorMessage}`, 4500)
            }
          }
          console.error({ error, reducerKey, actionKey })
          // posthog.captureException(error)
        },
      }),
    ],
  })
}
