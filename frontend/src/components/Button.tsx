import React from 'react'
import { clsx } from 'clsx'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'normal' | 'small' | 'tiny'
  color?:
    | 'blue'
    | 'teal'
    | 'gray'
    | 'red'
    | 'orange'
    | 'yellow'
    | 'light-gray'
    | 'none'
    | 'none-gray'
    | 'primary'
    | 'secondary'
    | 'tertiary'
  full?: boolean
}

export function buttonColor(color: ButtonProps['color']): string {
  return color === 'gray'
    ? 'frameos-secondary-button focus:ring-blue-400'
    : color === 'red'
    ? 'frameos-danger-button focus:ring-red-400'
    : color === 'orange'
    ? 'frameos-warning-button focus:ring-amber-400'
    : color === 'yellow'
    ? 'frameos-warning-button focus:ring-amber-400'
    : color === 'blue'
    ? 'frameos-primary-action focus:ring-blue-400'
    : color === 'light-gray' || color === 'secondary'
    ? 'frameos-secondary-button focus:ring-blue-400'
    : color === 'tertiary'
    ? 'frameos-secondary-button focus:ring-blue-400'
    : color === 'none'
    ? 'frameos-clear-button focus:ring-blue-400'
    : color === 'none-gray'
    ? 'frameos-clear-button focus:ring-blue-400'
    : color === 'teal'
    ? 'frameos-success-button focus:ring-teal-400'
    : 'frameos-primary-action focus:ring-blue-400'
}

export function buttonSize(size: 'normal' | 'small' | 'tiny' | undefined): string {
  return size === 'small'
    ? 'frameos-button focus:ring-1 focus:outline-none font-medium rounded-md text-sm px-2 py-1 text-center'
    : size === 'tiny'
    ? 'frameos-button focus:ring-1 focus:outline-none font-medium rounded-md text-sm px-1 py-1 text-center'
    : 'frameos-button focus:ring-2 focus:outline-none font-medium rounded-lg text-sm px-5 py-2.5 text-center'
}

export function Button({ size, color, children, className, disabled, full, ...props }: ButtonProps) {
  const colorClassName = buttonColor(color)
  const sizeClassName = buttonSize(size)
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
