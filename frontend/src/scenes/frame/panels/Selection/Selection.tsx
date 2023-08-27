import { frameLogic } from '../../frameLogic'
import { useValues } from 'kea'

export function Selection() {
  const { selectedApp } = useValues(frameLogic)
  return <>Hello {selectedApp?.name}</>
}
