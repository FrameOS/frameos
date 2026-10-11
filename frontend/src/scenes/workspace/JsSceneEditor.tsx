import { useActions, useValues } from 'kea'
import Editor from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor as importedEditor } from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { DocumentPlusIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline'

import { appSourceEditorLanguage, configureAppSourceEditor } from '../frame/panels/EditApp/EditApp'
import { inmemoryModelPath } from '../../utils/monacoPaths'
import { workspaceLogic } from './workspaceLogic'
import { isJsSceneSourceName, jsSceneEditorLogic } from './jsSceneEditorLogic'
import type { FrameId } from '../../types'

/**
 * The editor of a pure JS scene (docs/pure-js-scenes.md): the files of its
 * `sources` map down the left, Monaco on the right, every keystroke straight
 * into the frame form. One Monaco model per file, so `import "./icons"`
 * resolves and type-checks across files the way it does on the frame.
 */
export function JsSceneEditor({ frameId, sceneId }: { frameId: FrameId; sceneId: string }): JSX.Element {
  const logic = jsSceneEditorLogic({ frameId, sceneId })
  const { activeFile, fileNames, mainFile, sources, typeDeclarations } = useValues(logic)
  const { addFile, deleteFile, renameFile, setActiveFile, updateFile } = useActions(logic)
  const { theme } = useValues(workspaceLogic)
  const [monacoAndEditor, setMonacoAndEditor] = useState<[Monaco, importedEditor.IStandaloneCodeEditor] | null>(null)
  const monaco = monacoAndEditor?.[0] ?? null
  const siblingModelsRef = useRef<Map<string, importedEditor.ITextModel>>(new Map())
  const typeLibsRef = useRef<{ dispose: () => void }[]>([])

  // Every other file of the scene as a model, so cross-file imports resolve.
  useEffect(() => {
    if (!monaco) {
      return
    }
    const present = new Set<string>()
    for (const [file, content] of Object.entries(sources)) {
      present.add(file)
      const uri = monaco.Uri.parse(inmemoryModelPath('scene-editor', [sceneId], file))
      const existing = monaco.editor.getModel(uri)
      if (!existing) {
        siblingModelsRef.current.set(file, monaco.editor.createModel(content ?? '', appSourceEditorLanguage(file), uri))
      } else if (file !== activeFile && existing.getValue() !== content) {
        existing.setValue(content ?? '')
      }
    }
    for (const [file, model] of siblingModelsRef.current) {
      if (!present.has(file) && file !== activeFile) {
        if (!model.isDisposed()) {
          model.dispose()
        }
        siblingModelsRef.current.delete(file)
      }
    }
  }, [monaco, sources, sceneId, activeFile])

  useEffect(() => {
    return () => {
      for (const model of siblingModelsRef.current.values()) {
        if (!model.isDisposed()) {
          model.dispose()
        }
      }
      siblingModelsRef.current.clear()
    }
  }, [sceneId])

  // The `frameos` module types, with scene.state typed from the scene's fields.
  useEffect(() => {
    if (!monaco) {
      return
    }
    typeLibsRef.current.forEach((lib) => lib.dispose())
    typeLibsRef.current = [
      monaco.languages.typescript.typescriptDefaults.addExtraLib(
        typeDeclarations,
        inmemoryModelPath('scene-editor', [sceneId], 'frameos-scene-typescript.d.ts')
      ),
      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        typeDeclarations,
        inmemoryModelPath('scene-editor', [sceneId], 'frameos-scene-javascript.d.ts')
      ),
    ]
    return () => {
      typeLibsRef.current.forEach((lib) => lib.dispose())
      typeLibsRef.current = []
    }
  }, [monaco, sceneId, typeDeclarations])

  const promptForFileName = (title: string, initial: string): string | null => {
    const name = window.prompt(title, initial)?.trim() ?? ''
    if (!name) {
      return null
    }
    if (!isJsSceneSourceName(name)) {
      window.alert('Use a relative file name ending in .ts, .tsx, .js, .jsx or .json, like "icons.ts".')
      return null
    }
    return name
  }

  return (
    <div className="js-scene-editor flex h-full min-h-0 w-full">
      <div className="js-scene-editor__files frameos-inset flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-slate-200/80 bg-white/70 p-3 pt-16">
        <div className="frameos-muted mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
          <span>Files</span>
          <button
            type="button"
            title="Add a file"
            onClick={() => {
              const name = promptForFileName('New file name', 'helpers.ts')
              if (name) {
                addFile(name)
              }
            }}
            className="frameos-icon-button flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <DocumentPlusIcon className="h-4 w-4" />
          </button>
        </div>
        {fileNames.map((file) => (
          <div
            key={file}
            className={clsx(
              'group flex items-center gap-1 rounded-lg px-2 py-1 text-sm',
              file === activeFile ? 'frameos-primary-active text-white' : 'frameos-strong hover:bg-slate-100'
            )}
          >
            <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setActiveFile(file)}>
              {file}
            </button>
            {file !== mainFile ? (
              <>
                <button
                  type="button"
                  title="Rename"
                  onClick={() => {
                    const name = promptForFileName('Rename file', file)
                    if (name) {
                      renameFile(file, name)
                    }
                  }}
                  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100 group-hover:flex"
                >
                  <PencilSquareIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => {
                    if (window.confirm(`Delete ${file}?`)) {
                      deleteFile(file)
                    }
                  }}
                  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100 group-hover:flex"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </>
            ) : null}
          </div>
        ))}
        <div className="frameos-muted mt-auto pt-3 text-xs">
          <code>scene.ts</code> exports <code>render(scene, canvas)</code>. The preview re-renders as you type.
        </div>
      </div>
      <div className="js-scene-editor__code min-w-0 flex-1">
        <Editor
          height="100%"
          path={inmemoryModelPath('scene-editor', [sceneId], activeFile)}
          language={appSourceEditorLanguage(activeFile)}
          value={sources[activeFile] ?? ''}
          theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
          beforeMount={configureAppSourceEditor}
          onMount={(editor, monacoInstance) => setMonacoAndEditor([monacoInstance, editor])}
          onChange={(value) => updateFile(activeFile, value ?? '')}
          options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
        />
      </div>
    </div>
  )
}
