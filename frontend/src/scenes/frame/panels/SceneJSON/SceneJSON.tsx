import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { SceneJSONLogicProps, sceneJSONLogic } from './sceneJSONLogic'
import Editor, { Monaco } from '@monaco-editor/react'
import { diagramLogic } from '../Diagram/diagramLogic'
import { Button } from '../../../../components/Button'
import { workspaceLogic } from '../../../workspace/workspaceLogic'

interface SceneJSONProps {
  sceneId: string
}

export function SceneJSON({ sceneId }: SceneJSONProps) {
  const { frame } = useValues(frameLogic)
  const { theme } = useValues(workspaceLogic)
  const { sceneJSON, hasError, hasChanges } = useValues(sceneJSONLogic({ frameId: frame.id, sceneId: sceneId }))
  const { setEditedSceneJSON, saveChanges } = useActions(sceneJSONLogic({ frameId: frame.id, sceneId: sceneId }))

  function beforeMount(monaco: Monaco) {
    monaco.editor.defineTheme('darkframe', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#111827' },
    })
    monaco.editor.defineTheme('lightframe', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#f8fafc' },
    })
  }
  return (
    <div className="h-full relative">
      {hasChanges ? (
        <Button
          size="small"
          color={hasError ? 'red' : 'primary'}
          title={hasError ? 'Cannot save invalid JSON' : 'Save changes'}
          onClick={
            hasError
              ? () => {
                  window?.alert('Cannot save invalid JSON')
                }
              : saveChanges
          }
          className="absolute top-0 right-4 z-10"
        >
          Save
        </Button>
      ) : null}
      <Editor
        height="100%"
        path={`${frame.id}/scenes/${sceneId}.json`}
        language="json"
        value={sceneJSON}
        onChange={(value) => setEditedSceneJSON(value ?? null)}
        theme={theme === 'dark' ? 'darkframe' : 'lightframe'}
        beforeMount={beforeMount}
        options={{ minimap: { enabled: false } }}
      />
    </div>
  )
}
