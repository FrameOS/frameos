import { useMemo } from 'react'
import { Reveal } from './Reveal'

export function SecretField({ children, value }: { children?: React.ReactNode; value?: string }) {
  const alwaysShow = useMemo(() => {
    return value === undefined || value === '' || value === null
  }, []) // no deps

  if (alwaysShow) {
    return <div className="relative w-full">{children}</div>
  }

  return <Reveal className="border rounded-lg w-full px-2.5 py-3 bg-gray-600 border-gray-500">{children}</Reveal>
}
