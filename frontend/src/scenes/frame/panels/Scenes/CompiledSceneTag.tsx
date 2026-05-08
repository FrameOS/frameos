import { AdjustmentsHorizontalIcon, PencilSquareIcon } from '@heroicons/react/24/outline'
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
        <>
          This is a compiled scene. All changes require a full redeploy. Click{' '}
          <PencilSquareIcon className="w-5 h-5 inline-block" /> and then
          <AdjustmentsHorizontalIcon className="w-5 h-5 inline-block" /> in to change.
        </>
      }
    >
      <Tag className={className} color="none">
        🕖 COMPILED
      </Tag>
    </Tooltip>
  )
}
