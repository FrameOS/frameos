// Small shared pieces of the account pages' API calls.

import { apiFetch } from '../../../utils/apiFetch'

export type JsonPayload = Record<string, unknown> & { error?: string; message?: string }

/** The body as JSON, or undefined when there is none (a 204, a proxy error page). */
export async function readJsonPayload(response: Response): Promise<JsonPayload | undefined> {
  try {
    const payload: unknown = await response.json()
    return payload && typeof payload === 'object' ? (payload as JsonPayload) : undefined
  } catch {
    return undefined
  }
}

/** POST / PUT / PATCH / DELETE with a JSON body; the body is left out when undefined. */
export function apiCall(path: string, method: string, body?: unknown): Promise<Response> {
  return apiFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** The generic messages every account route shares; a page adds its own codes first. */
export function describeHttpError(status: number): string {
  if (status === 429) {
    return 'Too many attempts. Wait a few minutes and try again.'
  }
  if (status === 401) {
    return 'Your session expired. Reload the page and sign in again.'
  }
  return 'Something went wrong. Try again in a moment.'
}
