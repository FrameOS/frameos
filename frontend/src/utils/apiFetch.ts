import { router } from 'kea-router'

export interface ApiFetchOptions extends RequestInit {}

async function userExists(): Promise<boolean> {
  try {
    const resp = await fetch('/api/has_first_user', { method: 'GET', headers: { Accept: 'application/json' } })
    if (!resp.ok) {
      return false
    }
    const json = await resp.json()
    return json.has_first_user === true
  } catch (error) {
    console.error('Error checking if user exists:', error)
    return false
  }
}

export async function apiFetch(input: RequestInfo | URL, options: ApiFetchOptions = {}): Promise<Response> {
  let token = localStorage.getItem('token')

  let headers: HeadersInit = options.headers || {}
  if (token) {
    headers = {
      ...headers,
      Authorization: `Bearer ${token}`,
    }
  } else {
    const exists = await userExists()
    if (exists) {
      router.actions.push('/login')
      return new Promise(() => {})
    } else {
      router.actions.push('/signup')
      return new Promise(() => {})
    }
  }

  const response = await fetch(input, { ...options, headers })

  if (response.status === 401) {
    const exists = await userExists()
    if (exists) {
      router.actions.push('/login')
    } else {
      router.actions.push('/signup')
    }
    return new Promise(() => {})
  }

  return response
}
