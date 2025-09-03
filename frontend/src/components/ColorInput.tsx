import React, { forwardRef, useMemo } from 'react'
import { clsx } from 'clsx'
import Sketch from '@uiw/react-color-sketch'
import { Tooltip } from './Tooltip'
import { frameLogic } from '../scenes/frame/frameLogic'
import { withCustomPalette } from '../devices'

const PRESET_COLORS = ['#D0021B', '#F5A623', '#f8e61b', '#8B572A', '#7ED321', '#417505', '#BD10E0', '#9013FE']

export interface ColorPickerProps {
  value?: string
  onChange?: (value: string) => void
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const palette = useMemo(() => {
    for (const logic of frameLogic.findAllMounted()) {
      const frame = logic.values.frameForm || logic.values.frame
      const palette = frame.palette || withCustomPalette[frame.device || '']
      if (palette?.colors) {
        return palette.colors
      }
    }
    return PRESET_COLORS
  }, [])

  return (
    <Sketch
      color={value}
      disableAlpha={true}
      presetColors={palette}
      onChange={(color) => {
        onChange?.(color.hex)
      }}
    />
  )
}

export interface ColorInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value?: string
  onChange?: (value: string) => void
  theme?: 'node' | 'full'
}

export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(function ColorInput(
  { className, onChange, theme, ...props }: ColorInputProps,
  ref
) {
  return (
    <Tooltip noPadding title={<ColorPicker value={props.value} onChange={onChange} />}>
      <div
        className={clsx(
          (!theme || theme === 'full') &&
            'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white h-[34px] cursor-pointer',
          theme === 'node' &&
            'block border border-1 border-gray-500 text-white bg-zinc-800 focus:bg-zinc-700 hover:bg-zinc-700 w-full min-w-min px-0.5 h-[20px] cursor-pointer',
          className
        )}
        size={theme === 'node' ? 15 : 20}
        ref={ref}
        style={{
          backgroundColor: props.value || props.placeholder || '#ffffff',
          ...props.style,
        }}
        {...props}
      />
    </Tooltip>
  )
})
