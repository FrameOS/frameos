import React from 'react'
import { clsx } from 'clsx'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'normal' | 'small'
  color?: 'blue' | 'teal' | 'gray' | 'red' | 'light-gray'
}

export function Button({ size, color, children, className, disabled, ...props }: ButtonProps) {
  const colorClassName =
    color === 'gray'
      ? 'bg-gray-900 hover:bg-gray-950 focus:ring-gray-950'
      : color === 'red'
      ? 'bg-red-900 hover:bg-red-800 focus:ring-red-800'
      : color === 'blue'
      ? 'bg-blue-900 hover:bg-blue-800 focus:ring-blue-800'
      : color === 'light-gray'
      ? 'bg-gray-600 hover:bg-gray-500 focus:ring-gray-500'
      : 'bg-teal-900 hover:bg-teal-800 focus:ring-teal-800'
  const sizeClassName =
    size === 'small'
      ? 'w-full text-white focus:ring-1 focus:outline-none font-medium rounded-lg text-sm px-2 py-1 text-center'
      : 'w-full text-white focus:ring-2 focus:outline-none font-medium rounded-lg text-sm px-5 py-2.5 text-center'
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
