import { useActions, useValues } from 'kea'
import { Box } from '../../components/Box'
import { Spinner } from '../../components/Spinner'
import { Button } from '../../components/Button'
import { systemInfoLogic } from './systemInfoLogic'

const formatBytes = (value?: number | null): string => {
  if (value === null || value === undefined) {
    return '—'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const formatLoad = (value?: number | null): string => (value === null || value === undefined ? '—' : value.toFixed(2))

export function SystemInfo() {
  const {
    systemInfo,
    currentDisk,
    currentMemory,
    currentLoad,
    systemInfoLoading,
    systemMetrics,
    systemMetricsLoading,
  } = useValues(systemInfoLogic)
  const { loadSystemInfo } = useActions(systemInfoLogic)

  return (
    <Box className="p-4 space-y-4 @container">
      {!systemInfo && !systemMetrics && systemInfoLoading && systemMetricsLoading ? (
        <div className="flex justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-between">
            <p className="frameos-muted text-sm">Overview of the server running the backend.</p>
            <div className="flex items-center gap-2">
              {(systemInfoLoading || systemMetricsLoading) && <Spinner />}
              <Button size="small" color="secondary" onClick={loadSystemInfo}>
                Refresh
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
            <div className="frameos-inset rounded-xl border p-3">
              <div className="frameos-muted text-xs uppercase">Load (1m / 5m / 15m)</div>
              <div className="frameos-strong text-lg font-semibold">
                {formatLoad(currentLoad?.one)} / {formatLoad(currentLoad?.five)} / {formatLoad(currentLoad?.fifteen)}
              </div>
            </div>
            <div className="frameos-inset rounded-xl border p-3">
              <div className="frameos-muted text-xs uppercase">Memory</div>
              <div className="frameos-strong text-lg font-semibold">{formatBytes(currentMemory?.availableBytes)} free</div>
              <div className="frameos-muted text-xs">of {formatBytes(currentMemory?.totalBytes)} total</div>
            </div>
            <div className="frameos-inset rounded-xl border p-3">
              <div className="frameos-muted text-xs uppercase">Disk</div>
              <div className="frameos-strong text-lg font-semibold">{formatBytes(currentDisk?.freeBytes)} free</div>
              <div className="frameos-muted text-xs">of {formatBytes(currentDisk?.totalBytes)} total</div>
            </div>
          </div>
          <div className="space-y-3">
            <div className="frameos-strong flex items-center justify-between text-sm font-semibold">
              <span>Cache usage</span>
            </div>
            {systemInfoLoading ? (
              <div className="flex justify-center">
                <Spinner />
              </div>
            ) : (
              <div className="frameos-inset overflow-hidden rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="frameos-muted text-left text-xs uppercase tracking-wide">
                    <tr>
                      <th className="py-2 pl-3 pr-2 font-semibold">Name</th>
                      <th className="py-2 pr-2 font-semibold">Path</th>
                      <th className="py-2 pr-3 text-right font-semibold">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/70">
                    {(systemInfo?.caches ?? []).map((cache) => (
                      <tr key={cache.path} className="hover:bg-white/40">
                        <td className="py-2 pl-3 pr-2 align-top">{cache.name}</td>
                        <td className="frameos-muted py-2 pr-2 align-top font-mono text-xs">{cache.path}</td>
                        <td className="frameos-strong py-2 pr-3 text-right font-semibold align-top">
                          {formatBytes(cache.sizeBytes)}
                        </td>
                      </tr>
                    ))}
                    {(systemInfo?.caches?.length ?? 0) === 0 ? (
                      <tr>
                        <td className="frameos-muted py-3 text-center" colSpan={3}>
                          No cache directories found.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <div className="frameos-strong text-sm font-semibold">Database</div>
            {systemInfoLoading ? (
              <div className="flex justify-center">
                <Spinner />
              </div>
            ) : (
              <>
                <div className="frameos-strong text-sm">{systemInfo?.database?.path ?? 'Not using SQLite storage'}</div>
                <div className="frameos-muted text-xs">Size: {formatBytes(systemInfo?.database?.sizeBytes)}</div>
              </>
            )}
          </div>
        </>
      )}
    </Box>
  )
}
