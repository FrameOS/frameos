import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { sceneSourceLogic } from './sceneSourceLogic'
import { Spinner } from '../../../../components/Spinner'
import Editor, { Monaco } from '@monaco-editor/react'
import { panelsLogic } from '../panelsLogic'
import { useEffect, useState } from 'react'

export function SceneSource() {
  const { frame } = useValues(frameLogic)
  const { selectedSceneId } = useValues(panelsLogic({ frameId: frame.id }))
  const { sceneSource, sceneSourceLoading, modelMarkers } = useValues(
    sceneSourceLogic({ frameId: frame.id, sceneId: selectedSceneId })
  )
  const { updateSource } = useActions(sceneSourceLogic({ frameId: frame.id, sceneId: selectedSceneId }))

  function beforeMount(monaco: Monaco) {
    monaco.editor.defineTheme('darkframe', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#000000' },
    })
  }
  const [[monaco, editor], setMonacoAndEditor] = useState<[Monaco | null, any | null]>([null, null])

  useEffect(() => {
    if (monaco && editor) {
      const model = editor.getModel()
      if (model) {
        monaco.editor.setModelMarkers(model, 'owner', modelMarkers || [])
      }
    }
  }, [monaco, modelMarkers])

  const sceneFile = (selectedSceneId ?? '').replaceAll(/[^a-zA-Z0-9\-_]+/g, '_').replaceAll(/\W+/g, '')
  return (
    <div className="space-y-2 h-full">
      {sceneSource === '' && sceneSourceLoading ? (
        <Spinner />
      ) : (
        <Editor
          height="100%"
          path={`${frame.id}/scenes/scene_${sceneFile}.nim`}
          language="python" // no nim support :/
          value={sceneSource || 'Error generating source. Make sure to save the scene between changes.'}
          onChange={(value) => updateSource(value ?? '')}
          theme="darkframe"
          onMount={(editor, monaco) => setMonacoAndEditor([monaco, editor])}
          beforeMount={beforeMount}
          options={{ minimap: { enabled: false } }}
        />
      )}
    </div>
  )
}
