import { kea, key, path, props, selectors } from 'kea'
import { LogType } from '../../src/types'
import type { logsLogicType } from './logsLogicShimType'

// Swapped in for panels/Logs/logsLogic by the embedded-editor build: there is
// no backend or websocket, so the log feed (used only for runtime error
// badges on nodes) is permanently empty.

export interface LogsLogicProps {
  frameId: number
}

export const logsLogic = kea<logsLogicType>([
  path(['src', 'embed', 'logsLogicShim']),
  props({} as LogsLogicProps),
  key((props: LogsLogicProps) => props.frameId),
  selectors({
    logs: [() => [], (): LogType[] => []],
    logsLoading: [() => [], () => false],
  }),
])
