import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { scenesLogic } from './scenesLogic'
import { SceneForm } from './SceneForm'

export function Scenes() {
  const { frame } = useValues(frameLogic)
  const { scenes } = useValues(scenesLogic({ frameId: frame.id }))

  return (
    <div className="space-y-2 h-full">
      <div className="text-sm">Note: for now just one scene is supported</div>
      {scenes?.map((scene) => (
        <>
          <div className="font-bold font-md">Scene: {scene.name || scene.id}</div>
          <SceneForm sceneId={scene.id} />
        </>
      ))}
    </div>
  )
}
