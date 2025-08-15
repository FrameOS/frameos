import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from './Spinner'

// ---- Simple shared semaphore to cap concurrent <img> network loads ---- //
class LoadLimiter {
  private max: number
  private active = 0
  private queue: Array<() => void> = []
  constructor(max: number) {
    this.max = Math.max(1, max)
  }
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1
        let released = false
        const release = () => {
          if (released) return
          released = true
          this.active = Math.max(0, this.active - 1)
          const next = this.queue.shift()
          if (next) next()
        }
        resolve(release)
      }
      if (this.active < this.max) grant()
      else this.queue.push(grant)
    })
  }
}
const sharedLimiter = new LoadLimiter(5)

function appendToken(url: string, token?: string | null): string {
  if (!token) return url
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://local')
    u.searchParams.set('token', token)
    return u.pathname + (u.search ? u.search : '') + (u.hash || '')
  } catch {
    const hasQuery = url.includes('?')
    const hasToken = /([?&])token=/.test(url)
    if (hasToken) return url
    return url + (hasQuery ? '&' : '?') + 'token=' + encodeURIComponent(token)
  }
}

export interface DeferredImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  url: string
  token?: string | null
  startWhenVisible?: boolean
  spinnerClassName?: string
}

/** DeferredImage with visibility gate + 5-at-a-time limiter + spinner */
export function DeferredImage({
  url,
  token,
  startWhenVisible = true,
  spinnerClassName,
  className,
  onLoad,
  onError,
  ...imgProps
}: DeferredImageProps) {
  const [started, setStarted] = useState<boolean>(!startWhenVisible)
  const [actualSrc, setActualSrc] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false) // <- don't show spinner until we actually start
  const containerRef = useRef<HTMLDivElement | null>(null)
  const releaseRef = useRef<null | (() => void)>(null)

  const withToken = useMemo(() => appendToken(url, token), [url, token])

  // Visibility gate -> set state so effects re-run
  useEffect(() => {
    if (!startWhenVisible) return
    const el = containerRef.current
    if (!el) return

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setStarted(true)
            io.disconnect()
            break
          }
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [startWhenVisible])

  // Begin loading when started or when url/token changes
  useEffect(() => {
    let cancelled = false
    if (!started || actualSrc) return
    ;(async () => {
      const release = await sharedLimiter.acquire()
      if (cancelled) {
        release()
        return
      }
      releaseRef.current = release
      setIsLoading(true)
      setActualSrc(withToken)
    })()

    return () => {
      cancelled = true
    }
  }, [started, withToken, actualSrc])

  // Clean up limiter slot if unmounted mid-load
  useEffect(() => {
    return () => {
      if (releaseRef.current) {
        releaseRef.current()
        releaseRef.current = null
      }
    }
  }, [])

  const handleLoad: React.ReactEventHandler<HTMLImageElement> = (e) => {
    if (releaseRef.current) {
      releaseRef.current()
      releaseRef.current = null
    }
    setIsLoading(false)
    onLoad?.(e)
  }

  const handleError: React.ReactEventHandler<HTMLImageElement> = (e) => {
    if (releaseRef.current) {
      releaseRef.current()
      releaseRef.current = null
    }
    setIsLoading(false)
    onError?.(e)
  }

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Only show spinner once we've actually initiated a request */}
      {isLoading && actualSrc && (
        <div className="w-full h-full flex items-center justify-center absolute inset-0">
          <Spinner className={spinnerClassName || 'w-6 h-6'} color="white" />
        </div>
      )}

      {actualSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...imgProps}
          src={actualSrc}
          onLoad={handleLoad}
          onError={handleError}
          alt={imgProps.alt || ''}
          style={{ width: '100%', height: '100%', objectFit: (imgProps as any).objectFit || 'cover' }}
        />
      )}
    </div>
  )
}
