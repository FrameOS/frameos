import { useState } from 'react'

interface RevealProps {
  children: React.ReactNode
}

export function RevealDots() {
  return (
    <div className="flex items-center justify-start space-x-1">
      <div className="w-2 h-2 bg-teal-700 rounded-full" />
      <div className="w-2 h-2 bg-teal-700 rounded-full" />
      <div className="w-2 h-2 bg-teal-700 rounded-full" />
      <div className="w-2 h-2 bg-teal-700 rounded-full" />
      <div className="w-2 h-2 bg-teal-700 rounded-full" />
    </div>
  )
}

export function Reveal({ children }: RevealProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      {visible ? (
        children
      ) : (
        <div onClick={() => setVisible(true)} className="cursor-pointer">
          <RevealDots />
        </div>
      )}
    </div>
  )
}
