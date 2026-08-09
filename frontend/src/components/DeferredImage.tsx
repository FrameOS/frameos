import React, { useEffect, useRef, useState } from 'react'
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
// One pool per concurrency level, so a caller that needs a stricter cap gets
// its own queue instead of quietly changing everyone else's.
const limiters = new Map<number, LoadLimiter>()
function limiterFor(max: number): LoadLimiter {
  const key = Math.max(1, Math.floor(max))
  const existing = limiters.get(key)
  if (existing) return existing
  const created = new LoadLimiter(key)
  limiters.set(key, created)
  return created
}
const defaultMaxConcurrent = 5

export interface DeferredImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  url: string
  startWhenVisible?: boolean
  spinnerClassName?: string
  /**
   * How many of these may be in flight at once. Defaults to 5; an esp32 frame
   * serves its asset thumbnails from the device itself, one small HTTP server
   * on a microcontroller, so the asset panel asks for 1 there.
   */
  maxConcurrent?: number
}

/** DeferredImage with visibility gate + 5-at-a-time limiter + spinner */
export function DeferredImage({
  url,
  startWhenVisible = true,
  spinnerClassName,
  maxConcurrent = defaultMaxConcurrent,
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
      const release = await limiterFor(maxConcurrent).acquire()
      if (cancelled) {
        release()
        return
      }
      releaseRef.current = release
      setIsLoading(true)
      setActualSrc(url)
    })()

    return () => {
      cancelled = true
    }
  }, [started, url, actualSrc])

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
