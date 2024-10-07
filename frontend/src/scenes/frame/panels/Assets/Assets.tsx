import { useActions, useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { assetsLogic } from './assetsLogic'
import { panelsLogic } from '../panelsLogic'
import { Code } from '../../../../components/Code'
import { CloudArrowDownIcon } from '@heroicons/react/24/outline'

function humaniseSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  while (size > 1024 && unitIndex < units.length) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

export function Assets(): JSX.Element {
  const { frame } = useValues(frameLogic)
  const { assetsLoading, cleanedAssets } = useValues(assetsLogic({ frameId: frame.id }))
  const { openAsset } = useActions(panelsLogic({ frameId: frame.id }))
  return (
    <div className="space-y-2">
      {assetsLoading ? (
        <div>Loading assets...</div>
      ) : (
        <table className="w-full">
          <tbody>
            {cleanedAssets.map((asset) => (
              <tr key={asset.path} className="even:bg-gray-700 hover:bg-gray-900">
                <td onClick={() => openAsset(asset.path)} className="hover:underline cursor-pointer">
                  {asset.path}
                </td>
                <td className="text-nowrap">{humaniseSize(asset.size)}</td>
                <td>
                  <a href={`/api/frames/${frame.id}/asset?path=${encodeURIComponent(asset.path)}`} download>
                    <CloudArrowDownIcon className="w-5 h-5" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
