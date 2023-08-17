import React from 'react'
import { clsx } from 'clsx'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'normal' | 'small'
  color?: 'blue' | 'gray' | 'red'
}

export function Button({ size, color, children, className, disabled, ...props }: ButtonProps) {
  const colorClassName =
    color === 'gray'
      ? 'bg-gray-600 hover:bg-gray-700 focus:ring-gray-800'
      : color === 'red'
      ? 'bg-red-600 hover:bg-red-700 focus:ring-red-800'
      : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-800'
  const sizeClassName =
    size === 'small'
      ? 'w-full text-white focus:ring-4 focus:outline-none font-medium rounded-lg text-sm px-2 py-1 text-center'
      : 'w-full text-white focus:ring-4 focus:outline-none font-medium rounded-lg text-sm px-5 py-2.5 text-center'
  return (
    <button
      className={clsx(sizeClassName, colorClassName, disabled && 'opacity-30', className)}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
