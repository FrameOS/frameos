import { useState } from 'react'
import clsx from 'clsx'

interface RevealProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

export function RevealDots(props: React.HTMLProps<HTMLDivElement>) {
  return (
    <div className="flex items-center justify-start space-x-1" {...props}>
      <div className="h-2 w-2 rounded-full bg-current opacity-70" />
      <div className="h-2 w-2 rounded-full bg-current opacity-70" />
      <div className="h-2 w-2 rounded-full bg-current opacity-70" />
      <div className="h-2 w-2 rounded-full bg-current opacity-70" />
      <div className="h-2 w-2 rounded-full bg-current opacity-70" />
    </div>
  )
}

export function Reveal({ className, children, style }: RevealProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative w-full">
      {visible ? (
        children
      ) : (
        <div onClick={() => setVisible(true)} className={clsx('cursor-pointer', className)} style={style}>
          <RevealDots />
        </div>
      )}
    </div>
  )
}
