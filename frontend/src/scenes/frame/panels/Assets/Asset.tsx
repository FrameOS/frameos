import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../../../utils/apiFetch'
import { Button } from '../../../../components/Button'

interface AssetProps {
  path: string
}

export function Asset({ path }: AssetProps) {
  const { frame } = useValues(frameLogic)
  const lowerPath = path.toLowerCase()
  const isImage =
    lowerPath.endsWith('.png') ||
    lowerPath.endsWith('.jpg') ||
    lowerPath.endsWith('.jpeg') ||
    lowerPath.endsWith('.gif')
  const [isLoading, setIsLoading] = useState(true)
  const [asset, setAsset] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAsset() {
      setIsLoading(true)
      setAsset(null)
      const resource = await apiFetch(`/api/frames/${frame.id}/asset?path=${encodeURIComponent(path)}`)
      const blob = await resource.blob()
      setAsset(URL.createObjectURL(blob))
      setIsLoading(false)
    }
    fetchAsset()
  }, [path])

  return (
    <div className="w-full">
      {isLoading ? (
        <div>Loading...</div>
      ) : !asset ? (
        <div>Error loading asset</div>
      ) : isImage ? (
        <img
          onLoad={() => setIsLoading(false)}
          onError={() => setIsLoading(false)}
          className="max-w-full"
          src={asset}
          alt={path}
        />
      ) : (
        <div className="space-y-2">
          <div>{path}</div>
          <Button
            onClick={() => {
              const a = document.createElement('a')
              a.href = asset
              a.download = path
              a.click()
            }}
          >
            Download
          </Button>
        </div>
      )}
    </div>
  )
}
