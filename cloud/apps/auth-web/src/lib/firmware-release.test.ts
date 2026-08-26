import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLatestRelease, releaseFreshMs, releaseRetryMs, resetReleaseCacheForTests } from './firmware-release'

const fetchMock = vi.fn<typeof fetch>()

const releaseA = { assets: [], tag_name: 'v1.0.0' }
const releaseB = { assets: [], tag_name: 'v1.1.0' }

function githubAnswers(...responses: (() => Response | Promise<Response>)[]) {
  for (const make of responses) {
    fetchMock.mockImplementationOnce(() => Promise.resolve(make()))
  }
}

const ok = (release: unknown) => () => Response.json(release)
const rateLimited = () => new Response('rate limited', { status: 403 })

beforeEach(() => {
  resetReleaseCacheForTests()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('fetchLatestRelease cache', () => {
  it('asks GitHub once while the release is fresh', async () => {
    githubAnswers(ok(releaseA))
    expect(await fetchLatestRelease(1000)).toEqual(releaseA)
    expect(await fetchLatestRelease(1000 + releaseFreshMs - 1)).toEqual(releaseA)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the release goes stale', async () => {
    githubAnswers(ok(releaseA), ok(releaseB))
    expect(await fetchLatestRelease(1000)).toEqual(releaseA)
    expect(await fetchLatestRelease(1000 + releaseFreshMs)).toEqual(releaseB)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves the last good release when GitHub rate limits the refresh', async () => {
    githubAnswers(ok(releaseA), rateLimited)
    expect(await fetchLatestRelease(1000)).toEqual(releaseA)
    expect(await fetchLatestRelease(1000 + releaseFreshMs)).toEqual(releaseA)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves the stale release through a network error too', async () => {
    githubAnswers(ok(releaseA))
    expect(await fetchLatestRelease(1000)).toEqual(releaseA)
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')))
    expect(await fetchLatestRelease(1000 + releaseFreshMs)).toEqual(releaseA)
  })

  it('backs off after a failed refresh instead of retrying per request', async () => {
    githubAnswers(ok(releaseA), rateLimited, ok(releaseB))
    await fetchLatestRelease(1000)
    const stale = 1000 + releaseFreshMs
    expect(await fetchLatestRelease(stale)).toEqual(releaseA)
    // Inside the retry window: no new GitHub call, still the stale copy.
    expect(await fetchLatestRelease(stale + releaseRetryMs - 1)).toEqual(releaseA)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // After it: retried, and the fresh answer wins.
    expect(await fetchLatestRelease(stale + releaseRetryMs)).toEqual(releaseB)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps retrying when there is nothing cached to fall back on', async () => {
    githubAnswers(rateLimited, rateLimited, ok(releaseA))
    expect(await fetchLatestRelease(1000)).toBeUndefined()
    expect(await fetchLatestRelease(1001)).toBeUndefined()
    expect(await fetchLatestRelease(1002)).toEqual(releaseA)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('coalesces concurrent lookups into one GitHub call', async () => {
    let resolveGitHub: (response: Response) => void = () => {}
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveGitHub = resolve
        })
    )
    const first = fetchLatestRelease(1000)
    const second = fetchLatestRelease(1000)
    resolveGitHub(Response.json(releaseA))
    expect(await Promise.all([first, second])).toEqual([releaseA, releaseA])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the GitHub token when one is configured', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test')
    githubAnswers(ok(releaseA))
    await fetchLatestRelease(1000)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_test')
  })

  it('sends no authorization header without a token', async () => {
    vi.stubEnv('GITHUB_TOKEN', '')
    githubAnswers(ok(releaseA))
    await fetchLatestRelease(1000)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).not.toHaveProperty('authorization')
  })
})
