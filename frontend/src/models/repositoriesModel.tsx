import { actions, afterMount, kea, listeners, path, reducers, selectors } from 'kea'

import type { repositoriesModelType } from './repositoriesModelType'
import { loaders } from 'kea-loaders'
import { RepositoryType } from '../types'

export const repositoriesModel = kea<repositoriesModelType>([
  path(['src', 'models', 'repositoriesModel']),
  actions({
    updateRepository: (repository: RepositoryType) => ({ repository }),
    removeRepository: (id: string) => ({ id }),
    refreshRepository: (id: string) => ({ id }),
  }),
  loaders(({ values }) => ({
    repositories: [
      [] as RepositoryType[],
      {
        loadRepositories: async () => {
          try {
            const response = await fetch('/api/repositories')
            if (!response.ok) {
              throw new Error('Failed to fetch frames')
            }
            const data = await response.json()
            return data as RepositoryType[]
          } catch (error) {
            console.error(error)
            return values.repositories
          }
        },
        removeRepository: async ({ id }) => {
          try {
            const response = await fetch(`/api/repositories/${id}`, { method: 'DELETE' })
            if (!response.ok) {
              throw new Error('Failed to remove repository')
            }
            return values.repositories.filter((t) => t.id !== id)
          } catch (error) {
            console.error(error)
            return values.repositories
          }
        },
        refreshRepository: async ({ id }) => {
          try {
            const response = await fetch(`/api/repositories/${id}`, {
              method: 'PATCH',
              body: '{}',
              headers: {
                'Content-Type': 'application/json',
              },
            })
            if (!response.ok) {
              throw new Error('Failed to refresh repository')
            }
            const data = await response.json()
            return values.repositories.map((r) => (r.id === id ? data : r))
          } catch (error) {
            console.error(error)
            return values.repositories
          }
        },
      },
    ],
  })),
  reducers({
    repositories: {
      updateRepository: (state, { repository }) => {
        const index = state.findIndex((t) => t.id === repository.id)
        if (index === -1) {
          return [...state, repository]
        }
        return [...state.slice(0, index), repository, ...state.slice(index + 1)]
      },
    },
  }),
  afterMount(({ actions }) => {
    actions.loadRepositories()
  }),
])
