import { Tag } from '../../../../components/Tag'
import { Tooltip } from '../../../../components/Tooltip'

interface CompiledSceneTagProps {
  className?: string
}

export function CompiledSceneTag({ className }: CompiledSceneTagProps): JSX.Element {
  return (
    <Tooltip
      containerClassName="inline-block align-middle"
      title={
        <>This is a compiled scene. All changes require a full FrameOS recompilation. Change under the scene info.</>
      }
    >
      <Tag className={className} color="none">
        🕖 COMPILED
      </Tag>
    </Tooltip>
  )
}
