import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { frameLogic } from '../../frameLogic'
import { workspaceLogic } from '../../../workspace/workspaceLogic'
import { ReactJsonComponent } from '../../../../utils/reactJsonView'

interface DebugProps {
  scrollContainer?: boolean
}

export function Debug({ scrollContainer = true }: DebugProps = {}) {
  const { frameForm } = useValues(frameLogic)
  const { setFrameFormValues } = useActions(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const setValue = (value: any) => {
    setFrameFormValues(value)
  }
  const sceneCount = frameForm.scenes?.length ?? 0
  const keyCount = Object.keys(frameForm).length

  if (!ReactJsonComponent) {
    return (
      <div className="frame-tool-panel flex min-h-[calc(100vh-3rem)] items-center justify-center text-sm text-red-500">
        Unable to load JSON debug viewer on this build.
      </div>
    )
  }

  return (
    <div
      className={clsx(
        'frame-tool-panel flex flex-col',
        scrollContainer ? 'h-full min-h-0 overflow-auto' : 'min-h-[calc(100vh-3rem)] overflow-visible'
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="frame-tool-muted text-xs font-semibold uppercase tracking-wide">Debug</div>
          <h2 className="frameos-strong truncate text-2xl font-bold tracking-normal text-slate-950">Frame JSON</h2>
        </div>
        <div className="frame-tool-muted flex flex-wrap items-center gap-3 text-xs font-semibold">
          <span>{keyCount} keys</span>
          <span>
            {sceneCount} {sceneCount === 1 ? 'scene' : 'scenes'}
          </span>
        </div>
      </div>
      <div className="min-w-max flex-1 pb-8 font-mono text-sm">
        <ReactJsonComponent
          src={frameForm}
          collapsed={2}
          theme={theme === 'dark' ? 'ocean' : 'rjv-default'}
          name="frame"
          displayDataTypes={false}
          enableClipboard
          style={{
            background: 'transparent',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: '0.875rem',
          }}
          onEdit={(edit: any) => setValue(edit.updated_src)}
          onAdd={(add: any) => setValue(add.updated_src)}
          onDelete={(del: any) => setValue(del.updated_src)}
        />
      </div>
    </div>
  )
}
