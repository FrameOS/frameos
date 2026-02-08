import { afterMount, kea } from 'kea'
import { loaders } from 'kea-loaders'

export const controlLogic = kea([
  loaders(() => ({
    frame: {
      load: async (id: string) => {
        const response = await fetch(`/state`)
        if (!response.ok) {
          throw new Error(`Failed to load state`)
        }
        return await response.json()
      },
    },
  })),
  afterMount(({ actions, props }) => {
    actions.loadFrame(props.id)
  }),
])
