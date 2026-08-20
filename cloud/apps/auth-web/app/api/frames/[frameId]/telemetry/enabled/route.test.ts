import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAuditEvent } from '../../../../../../src/lib/audit'
import { enqueueFrameCommand, frameForAccount } from '../../../../../../src/lib/frames'
import { rateLimitResponse } from '../../../../../../src/lib/rate-limit'
import { readSession } from '../../../../../../src/lib/session'
import { POST } from './route'

// The OWNER's per-frame telemetry switch — the explicit grant for frames
// whose pre-2026-08-03 enrollment never received telemetry:logs/metrics.
// Database stubbed so the gates, the scope arithmetic and the restart nudge
// can be pinned; the sibling service-settings route carries the end-to-end
// integration coverage for the scope-row mechanics.

vi.mock('../../../../../../src/lib/rate-limit', () => ({
  rateLimitResponse: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../../../../../../src/lib/csrf', () => ({
  csrfResponse: vi.fn(() => undefined),
}))
vi.mock('../../../../../../src/lib/session', () => ({
  readSession: vi.fn(),
}))
vi.mock('../../../../../../src/lib/audit', () => ({
  recordAuditEvent: vi.fn(() => Promise.resolve()),
}))
vi.mock('../../../../../../src/lib/frames', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueFrameCommand: vi.fn(() => Promise.resolve({ id: 'cmd-1' } as never)),
  frameForAccount: vi.fn(),
}))
vi.mock('../../../../../../src/lib/device-flow', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireDatabase: () => ({ db: fakeDb as never, response: undefined }),
}))

const sessionMock = vi.mocked(readSession)
const frameMock = vi.mocked(frameForAccount)
const enqueueMock = vi.mocked(enqueueFrameCommand)
const auditMock = vi.mocked(recordAuditEvent)
const rateLimitMock = vi.mocked(rateLimitResponse)

const frameId = '11111111-2222-3333-4444-555555555555'
const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const linkedClientId = 'cccccccc-dddd-eeee-ffff-000000000000'

let linkedClientRows: { id: string; providerClientMetadata: unknown }[] = []
let updates: Record<string, unknown>[] = []

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(linkedClientRows) }),
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values)
      return { where: () => Promise.resolve(undefined) }
    },
  }),
}

function request(body: unknown) {
  return new NextRequest(`https://cloud.example/api/frames/${frameId}/telemetry/enabled`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: 'https://cloud.example' },
    method: 'POST',
  })
}

const routeParams = (id: string) => ({ params: Promise.resolve({ frameId: id }) })

function grantedScopes() {
  const metadata = updates.at(-1)?.providerClientMetadata as { requestedScopes?: string[] } | undefined
  return metadata?.requestedScopes
}

beforeEach(() => {
  updates = []
  // A 2026-07 enrollment: frame:managed only, no telemetry.
  linkedClientRows = [
    {
      id: linkedClientId,
      providerClientMetadata: {
        enrolledVia: 'claim_token',
        requestedScopes: ['frame:managed', 'settings:services'],
      },
    },
  ]
  sessionMock.mockResolvedValue({
    accountId,
    providerSubject: 'subject',
  } as never)
  frameMock.mockResolvedValue({
    accountId,
    id: frameId,
    linkedClientId,
    status: 'active',
  } as never)
  enqueueMock.mockClear()
  auditMock.mockClear()
  rateLimitMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/frames/[frameId]/telemetry/enabled', () => {
  const post = (body: unknown, id = frameId) => POST(request(body), routeParams(id))

  it('grants both telemetry scopes, keeps the rest, and restarts the runtime', async () => {
    const response = await post({ enabled: true })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      command_id: 'cmd-1',
      enabled: true,
      status: 'updated',
    })
    expect(grantedScopes()).toEqual(['frame:managed', 'settings:services', 'telemetry:logs', 'telemetry:metrics'])
    expect((updates.at(-1)?.providerClientMetadata as Record<string, unknown>).enrolledVia).toBe('claim_token')
    // Scopes are pinned at the WebSocket upgrade, so the grant is inert until
    // the device reconnects — hence a short-lived restart_runtime.
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        createdByAccountId: accountId,
        frameId,
        type: 'restart_runtime',
      })
    )
  })

  it('fills in a half grant', async () => {
    linkedClientRows[0]!.providerClientMetadata = {
      requestedScopes: ['frame:managed', 'telemetry:logs'],
    }

    await post({ enabled: true })

    expect(grantedScopes()).toEqual(['frame:managed', 'telemetry:logs', 'telemetry:metrics'])
  })

  it('revokes by removing both scopes, and restarts so the hub stops accepting', async () => {
    linkedClientRows[0]!.providerClientMetadata = {
      requestedScopes: ['frame:managed', 'telemetry:logs', 'telemetry:metrics', 'settings:services'],
    }

    const response = await post({ enabled: false })

    expect(response.status).toBe(200)
    expect(grantedScopes()).toEqual(['frame:managed', 'settings:services'])
    expect(enqueueMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'restart_runtime' }))
  })

  it('is idempotent: a no-op toggle rewrites nothing and restarts nothing', async () => {
    linkedClientRows[0]!.providerClientMetadata = {
      requestedScopes: ['frame:managed', 'telemetry:logs', 'telemetry:metrics'],
    }

    const response = await post({ enabled: true })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ command_id: null })
    expect(updates).toHaveLength(0)
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('audits the flag only', async () => {
    await post({ enabled: true })

    const event = auditMock.mock.calls[0]?.[1]
    expect(event?.eventType).toBe('frame.telemetry_scope_changed')
    expect(event?.metadata).toEqual({ enabled: true })
    expect(event?.target).toEqual({ commandId: 'cmd-1', frameId })
  })

  it('grants but does not restart a frame that is not active', async () => {
    frameMock.mockResolvedValue({
      accountId,
      id: frameId,
      linkedClientId,
      status: 'pending',
    } as never)

    const response = await post({ enabled: true })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ command_id: null })
    expect(grantedScopes()).toContain('telemetry:logs')
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    sessionMock.mockResolvedValue(undefined as never)

    const response = await post({ enabled: true })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'login_required' })
  })

  it('404s a frame the session does not own', async () => {
    frameMock.mockResolvedValue(undefined as never)

    const response = await post({ enabled: true })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_frame' })
  })

  it('400s a body without a boolean `enabled`', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }]) {
      const response = await post(body)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_enabled',
      })
    }
    expect(updates).toHaveLength(0)
  })

  it('relays the rate limiter', async () => {
    rateLimitMock.mockResolvedValueOnce(new Response(null, { status: 429 }) as never)

    const response = await post({ enabled: true })

    expect(response.status).toBe(429)
    expect(rateLimitMock.mock.calls[0]?.[1]).toBe('frames:telemetry-scope')
  })
})
