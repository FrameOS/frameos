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
    <Box className="p-4 space-y-4">
      {!systemInfo && !systemMetrics && systemInfoLoading && systemMetricsLoading ? (
        <div className="flex justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-200">Overview of the server running the backend.</p>
            <div className="flex items-center gap-2">
              {(systemInfoLoading || systemMetricsLoading) && <Spinner />}
              <Button size="small" color="secondary" onClick={loadSystemInfo}>
                Refresh
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 @md:grid-cols-3">
            <div className="rounded border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs uppercase text-slate-400">Load (1m / 5m / 15m)</div>
              <div className="text-lg font-semibold">
                {formatLoad(currentLoad?.one)} / {formatLoad(currentLoad?.five)} / {formatLoad(currentLoad?.fifteen)}
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs uppercase text-slate-400">Memory</div>
              <div className="text-lg font-semibold">{formatBytes(currentMemory?.availableBytes)} free</div>
              <div className="text-xs text-slate-400">of {formatBytes(currentMemory?.totalBytes)} total</div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-900 p-3">
              <div className="text-xs uppercase text-slate-400">Disk</div>
              <div className="text-lg font-semibold">{formatBytes(currentDisk?.freeBytes)} free</div>
              <div className="text-xs text-slate-400">of {formatBytes(currentDisk?.totalBytes)} total</div>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Cache usage</span>
            </div>
            {systemInfoLoading ? (
              <div className="flex justify-center">
                <Spinner />
              </div>
            ) : (
              <div className="overflow-hidden rounded border border-slate-800/80 bg-slate-950/50">
                <table className="w-full text-sm">
                  <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="py-2 pl-3 pr-2 font-semibold">Name</th>
                      <th className="py-2 pr-2 font-semibold">Path</th>
                      <th className="py-2 pr-3 text-right font-semibold">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {(systemInfo?.caches ?? []).map((cache) => (
                      <tr key={cache.path} className="hover:bg-slate-900/40">
                        <td className="py-2 pl-3 pr-2 align-top">{cache.name}</td>
                        <td className="py-2 pr-2 align-top font-mono text-xs text-slate-200">{cache.path}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-slate-100 align-top">
                          {formatBytes(cache.sizeBytes)}
                        </td>
                      </tr>
                    ))}
                    {(systemInfo?.caches?.length ?? 0) === 0 ? (
                      <tr>
                        <td className="py-3 text-center text-slate-400" colSpan={3}>
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
            <div className="text-sm font-semibold">Database</div>
            {systemInfoLoading ? (
              <div className="flex justify-center">
                <Spinner />
              </div>
            ) : (
              <>
                <div className="text-sm text-slate-200">{systemInfo?.database?.path ?? 'Not using SQLite storage'}</div>
                <div className="text-xs text-slate-400">Size: {formatBytes(systemInfo?.database?.sizeBytes)}</div>
              </>
            )}
          </div>
        </>
      )}
    </Box>
  )
}
