const sceneCardWidths = ['w-28', 'w-24', 'w-32', 'w-20', 'w-28', 'w-24']

export function FrameHomeTopBarLoadingSkeleton(): JSX.Element {
  return (
    <div className="mb-8 flex flex-col items-stretch justify-between gap-4 @md:flex-row @md:items-center">
      <div className="w-full max-w-sm">
        <div className="frameos-skeleton-line h-12 w-full animate-pulse rounded-2xl" />
      </div>
      <div className="flex items-center justify-end gap-3">
        <div className="frameos-skeleton-line h-12 w-12 animate-pulse rounded-xl" />
      </div>
    </div>
  )
}

function SkeletonSceneCard({ index }: { index: number }): JSX.Element {
  return (
    <div className="frameos-skeleton-surface h-36 w-36 shrink-0 overflow-hidden rounded-lg shadow-lg">
      <div className="frameos-skeleton-media h-24 animate-pulse" />
      <div className="space-y-2 p-3">
        <div className={`frameos-skeleton-line h-3 max-w-full animate-pulse rounded-full ${sceneCardWidths[index]}`} />
        <div className="frameos-skeleton-line h-2 w-20 animate-pulse rounded-full opacity-70" />
      </div>
    </div>
  )
}

export function FrameDashboardLoadingSkeleton({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`@container space-y-8 ${className}`}>
      <div className="frameos-muted flex items-center gap-3 text-sm font-semibold uppercase tracking-wide">
        <div className="frameos-skeleton-line h-4 w-16 animate-pulse rounded-full" />
        <div className="frameos-skeleton-line h-5 w-8 animate-pulse rounded-full" />
      </div>
      <section className="@container">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="frameos-skeleton-media h-12 w-12 shrink-0 animate-pulse rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="frameos-skeleton-line h-6 w-56 max-w-full animate-pulse rounded-full" />
              <div className="frameos-skeleton-line h-3 w-44 max-w-full animate-pulse rounded-full opacity-70" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="frameos-skeleton-line h-9 w-20 animate-pulse rounded-lg" />
            {[0, 1, 2].map((index) => (
              <div key={index} className="frameos-skeleton-media h-9 w-9 animate-pulse rounded-lg" />
            ))}
          </div>
        </div>
        <div className="grid gap-5 @2xl:grid-cols-[minmax(0,22rem)_minmax(22rem,1fr)] @2xl:items-start">
          <div className="frameos-skeleton-surface min-w-0 overflow-hidden rounded-lg shadow-xl shadow-slate-300/25">
            <div className="frameos-skeleton-media aspect-square w-full animate-pulse" />
            <div className="frameos-divider border-t border-slate-200/80 px-3 py-3">
              <div className="frameos-skeleton-line h-4 w-48 max-w-full animate-pulse rounded-full" />
              <div className="frameos-skeleton-line mt-2 h-3 w-64 max-w-full animate-pulse rounded-full opacity-60" />
            </div>
          </div>
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="frameos-skeleton-line h-8 w-24 animate-pulse rounded-lg" />
              ))}
            </div>
            <div className="flex flex-wrap gap-4">
              {sceneCardWidths.map((_, index) => (
                <SkeletonSceneCard key={index} index={index} />
              ))}
              <div className="frameos-skeleton-surface flex h-36 w-36 shrink-0 items-center justify-center rounded-lg">
                <div className="frameos-skeleton-media h-12 w-12 animate-pulse rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
