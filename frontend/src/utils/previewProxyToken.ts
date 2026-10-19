// Short-lived tokens for the preview's HTTP proxy. FrameOS's backend and
// cloud answer `POST <proxyUrl>/token` with `{token, expiresIn}` (seconds) for
// a page that may use the proxy (its session on a backend, the same-origin
// check on the cloud), and take that token in the `X-FrameOS-Preview-Token`
// header of a proxy request in place of either. The worker sends it, so the
// proxy keeps working for a worker that has no cookie and no origin of its
// own (one moved into a sandboxed iframe).
//
// This is frameos/wasm/src/proxyToken.ts (the frameos-wasm package the
// cloud's scene store previews through) for this frontend, which drives the
// worker itself and does not depend on the package. Change them together:
// the cloud's shared-spa test `preview-proxy-token.test.ts` runs both.

/** The request header a proxy request carries its token in. */
export const PREVIEW_PROXY_TOKEN_HEADER = 'X-FrameOS-Preview-Token'

export interface PreviewProxyToken {
  token: string
  /** Seconds until the token stops working. */
  expiresIn: number
}

/** Where tokens for `proxyUrl` are minted: the same path plus `/token`. */
export function previewProxyTokenUrl(proxyUrl: string): string {
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/'
  const url = new URL(proxyUrl, base)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/token`
  return url.toString()
}

type MintResult = PreviewProxyToken | 'unsupported' | 'failed'

async function requestPreviewProxyToken(proxyUrl: string): Promise<MintResult> {
  let response: Response
  try {
    response = await fetch(previewProxyTokenUrl(proxyUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  } catch {
    return 'failed'
  }
  if (!response.ok) {
    // No token route (an older server, a host's own proxy) or no right to
    // one: asking again will not change that. Rate limits and outages will.
    return [401, 403, 404, 405].includes(response.status) ? 'unsupported' : 'failed'
  }
  try {
    const body = (await response.json()) as { token?: unknown; expiresIn?: unknown }
    const expiresIn = Number(body.expiresIn)
    if (typeof body.token !== 'string' || !body.token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return 'failed'
    }
    return { token: body.token, expiresIn }
  } catch {
    return 'failed'
  }
}

/** A token for `proxyUrl`, or null when none could be had: the preview then
 * runs without one, as it did before tokens. */
export async function mintPreviewProxyToken(proxyUrl: string): Promise<PreviewProxyToken | null> {
  if (!proxyUrl) {
    return null
  }
  const result = await requestPreviewProxyToken(proxyUrl)
  return typeof result === 'string' ? null : result
}

/**
 * Keep a preview supplied with tokens: mint one now (or take `initial`, the
 * one the worker started with) and a fresh one when two thirds of each
 * lifetime have passed, handing every new token to `onToken`. A failed mint
 * is retried a minute later; a server without a token route is left alone.
 * Returns the function that stops it.
 */
export function keepPreviewProxyTokenFresh(
  proxyUrl: string,
  onToken: (token: string) => void,
  initial: PreviewProxyToken | null = null
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (seconds: number): void => {
    timer = setTimeout(run, Math.max(30, seconds) * 1000)
  }
  const run = async (): Promise<void> => {
    timer = null
    const result = await requestPreviewProxyToken(proxyUrl)
    if (stopped || result === 'unsupported') {
      return
    }
    if (result === 'failed') {
      schedule(60)
      return
    }
    onToken(result.token)
    schedule((result.expiresIn * 2) / 3)
  }
  if (!proxyUrl) {
    return () => {}
  }
  if (initial) {
    schedule((initial.expiresIn * 2) / 3)
  } else {
    void run()
  }
  return () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
