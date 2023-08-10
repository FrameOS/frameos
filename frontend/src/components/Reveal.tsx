import { useState } from 'react'

interface RevealProps {
  children: React.ReactNode
}

export function Reveal({ children }: RevealProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      {visible ? (
        children
      ) : (
        <div onClick={() => setVisible(true)} className="cursor-pointer">
          <div className="flex items-center justify-start space-x-1">
            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
          </div>
        </div>
      )}
    </div>
  )
}
