import { useState } from 'react'
import clsx from 'clsx'

interface RevealProps {
  children: React.ReactNode
  className?: string
}

export function RevealDots(props: React.HTMLProps<HTMLDivElement>) {
  return (
    <div className="flex items-center justify-start space-x-1" {...props}>
      <div className="w-2 h-2 bg-[#a1a2ce] rounded-full" />
      <div className="w-2 h-2 bg-[#a1a2ce] rounded-full" />
      <div className="w-2 h-2 bg-[#a1a2ce] rounded-full" />
      <div className="w-2 h-2 bg-[#a1a2ce] rounded-full" />
      <div className="w-2 h-2 bg-[#a1a2ce] rounded-full" />
    </div>
  )
}

export function Reveal({ className, children }: RevealProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative w-full">
      {visible ? (
        children
      ) : (
        <div onClick={() => setVisible(true)} className={clsx('cursor-pointer', className)}>
          <RevealDots />
        </div>
      )}
    </div>
  )
}
