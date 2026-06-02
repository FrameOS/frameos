import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { getBasePath } from './getBasePath'

function monacoWorkerUrl(label: string): string {
  const worker =
    label === 'json'
      ? 'json.worker'
      : label === 'css' || label === 'scss' || label === 'less'
      ? 'css.worker'
      : label === 'html' || label === 'handlebars' || label === 'razor'
      ? 'html.worker'
      : label === 'typescript' || label === 'javascript'
      ? 'ts.worker'
      : 'editor.worker'

  return `${getBasePath()}/static/monaco/${worker}.js`
}

;(globalThis as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    return new Worker(monacoWorkerUrl(label), { name: label, type: 'module' })
  },
}

loader.config({ monaco })
