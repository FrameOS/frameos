import React from 'react'
import { clsx } from 'clsx'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'normal' | 'small' | 'tiny'
  color?: 'blue' | 'teal' | 'gray' | 'red' | 'light-gray' | 'none' | 'none-gray' | 'primary' | 'secondary'
  full?: boolean
}

export function buttonColor(color: ButtonProps['color']): string {
  return color === 'gray'
    ? 'bg-gray-900 hover:bg-gray-950 focus:ring-gray-950'
    : color === 'red'
    ? 'bg-red-900 hover:bg-red-800 focus:ring-red-800'
    : color === 'blue'
    ? 'bg-blue-900 hover:bg-blue-800 focus:ring-blue-800'
    : color === 'light-gray' || color === 'secondary'
    ? 'bg-gray-600 hover:bg-gray-500 focus:ring-gray-500'
    : color === 'none'
    ? 'hover:bg-[#484984] focus:ring-[#484984]'
    : color === 'none-gray'
    ? 'hover:bg-gray-950 focus:ring-gray-950'
    : color === 'teal'
    ? 'bg-teal-700 hover:bg-teal-600 focus:ring-teal-600'
    : 'bg-[#4a4b8c] hover:bg-[#484984] focus:ring-[#484984]'
}

export function Button({ size, color, children, className, disabled, full, ...props }: ButtonProps) {
  const colorClassName = buttonColor(color)
  const sizeClassName =
    size === 'small'
      ? 'text-white focus:ring-1 focus:outline-none font-medium rounded-lg text-sm px-2 py-1 text-center'
      : size === 'tiny'
      ? 'text-white focus:ring-1 focus:outline-none font-medium rounded-lg text-sm px-1 py-1 text-center'
      : 'text-white focus:ring-2 focus:outline-none font-medium rounded-lg text-sm px-5 py-2.5 text-center'
  return (
    <button
      className={clsx(sizeClassName, colorClassName, full && 'w-full', disabled && 'opacity-30', className)}
      disabled={disabled}
      type={props.type || 'button'}
      {...props}
    >
      {children}
    </button>
  )
}
