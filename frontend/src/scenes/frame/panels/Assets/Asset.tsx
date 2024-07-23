import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { useState } from 'react'

function humaniseSize(size: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  while (size > 1024 && unitIndex < units.length) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}
interface AssetProps {
  path: string
}

export function Asset({ path }: AssetProps) {
  const { frame } = useValues(frameLogic)
  const isImage = path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif')
  const [isLoading, setIsLoading] = useState(true)

  return (
    <div className="w-full">
      {isImage ? (
        <>
          <img
            onLoad={() => setIsLoading(false)}
            onError={() => setIsLoading(false)}
            className="max-w-full"
            src={`/api/frames/${frame.id}/asset?path=${encodeURIComponent(path)}`}
            alt={path}
          />
          {isLoading ? <div>Loading...</div> : null}
        </>
      ) : (
        <>{path}</>
      )}
    </div>
  )
}
