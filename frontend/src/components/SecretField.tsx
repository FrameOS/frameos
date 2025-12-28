import { useMemo } from 'react'
import { Reveal } from './Reveal'

export function SecretField(props: { children?: React.ReactNode; value?: string }) {
  const alwaysShow = useMemo(() => {
    return 'value' in props && (props.value === undefined || props.value === '' || props.value === null)
  }, []) // no deps

  if (alwaysShow) {
    return <div className="relative w-full">{props.children}</div>
  }

  return <Reveal className="border rounded-lg w-full px-2.5 py-3 bg-gray-600 border-gray-500">{props.children}</Reveal>
}
