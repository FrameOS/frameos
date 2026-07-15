import { getBasePath } from './getBasePath'

type ProjectResponse = { id: number }
type ProjectsListResponse = { projects: ProjectResponse[] }

const PROJECT_ID_STORAGE_KEY = 'frameos.currentProjectId'

let currentProjectId: number | null = null
let currentProjectPromise: Promise<number> | null = null

function readStoredProjectId(): number | null {
  if (typeof window === 'undefined') {
    return null
  }
  const value = window.localStorage.getItem(PROJECT_ID_STORAGE_KEY)
  const projectId = Number(value)
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null
}

function storeProjectId(projectId: number): void {
  currentProjectId = projectId
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, String(projectId))
  }
}

function selectProjectId(projects: ProjectResponse[]): number | null {
  const storedProjectId = readStoredProjectId()
  const storedProject = storedProjectId ? projects.find((project) => project.id === storedProjectId) : null
  const projectId = storedProject?.id ?? projects[0]?.id

  return Number.isInteger(projectId) && projectId > 0 ? projectId : null
}

export function cachedProjectId(): number | null {
  return currentProjectId
}

export function clearCachedProjectId(): void {
  currentProjectId = null
  currentProjectPromise = null
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(PROJECT_ID_STORAGE_KEY)
  }
}

export async function getCurrentProjectId(): Promise<number> {
  if (currentProjectId) {
    return currentProjectId
  }
  // The standalone embedded editor has no backend (and apiFetch is not on
  // this path, so its synthetic-404 guard doesn't apply): fail fast instead
  // of firing a request that can never succeed.
  if (typeof window !== 'undefined' && (window as any).FRAMEOS_EMBEDDED_NO_BACKEND) {
    throw new Error('No backend in the embedded editor')
  }
  if (!currentProjectPromise) {
    currentProjectPromise = fetch(`${getBasePath()}/api/projects`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Unable to load projects')
        }
        const payload = (await response.json()) as ProjectsListResponse
        const projectId = selectProjectId(payload.projects ?? [])
        if (!projectId) {
          throw new Error('No project available')
        }
        storeProjectId(projectId)
        return projectId
      })
      .finally(() => {
        currentProjectPromise = null
      })
  }
  return currentProjectPromise
}

export function isProjectScopedApiPath(path: string): boolean {
  if (!path.startsWith('/api/') || path.startsWith('/api/projects/')) {
    return false
  }
  if (
    path === '/api/login' ||
    path === '/api/logout' ||
    path === '/api/signup' ||
    path === '/api/has_first_user' ||
    path === '/api/user' ||
    path.startsWith('/api/user/') ||
    path.startsWith('/api/system/') ||
    path === '/api/generate_ssh_keys' ||
    path === '/api/log' ||
    path === '/api/repositories/system' ||
    path.startsWith('/api/repositories/system/')
  ) {
    return false
  }
  return [
    '/api/ai',
    '/api/apps',
    '/api/assets',
    '/api/fonts',
    '/api/frame-bootstrap',
    '/api/frames',
    '/api/repositories',
    '/api/settings',
    '/api/templates',
  ].some((prefix) => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?'))
}

export function projectApiPathFromCache(path: string): string {
  const projectId = cachedProjectId()
  return projectApiPathForProject(projectId, path)
}

export function projectApiPathForProject(projectId: number | null | undefined, path: string): string {
  if (!projectId || !isProjectScopedApiPath(path)) {
    return path
  }
  return `/api/projects/${projectId}${path.slice('/api'.length)}`
}

export async function projectApiPath(path: string): Promise<string> {
  if (!isProjectScopedApiPath(path)) {
    return path
  }
  const projectId = await getCurrentProjectId()
  return projectApiPathForProject(projectId, path)
}

export async function projectWebSocketPath(path: string): Promise<string> {
  if (!path.startsWith('/ws/terminal/')) {
    return path
  }
  const projectId = await getCurrentProjectId()
  return `/ws/projects/${projectId}${path.slice('/ws'.length)}`
}
