import React, { useState, Fragment, forwardRef, useMemo } from 'react'
import { clsx } from 'clsx'
import { Tooltip } from './Tooltip'
import { frameLogic } from '../scenes/frame/frameLogic'
import { withCustomPalette } from '../devices'

import type * as CSS from 'csstype'
import Saturation from '@uiw/react-color-saturation'
import Alpha, { PointerProps } from '@uiw/react-color-alpha'
import EditableInput from '@uiw/react-color-editable-input'
import RGBA from '@uiw/react-color-editable-input-rgba'
import EditableInputHSLA from '@uiw/react-color-editable-input-hsla'
import Hue from '@uiw/react-color-hue'
import {
  validHex,
  HsvaColor,
  hsvaToHex,
  hsvaToRgbaString,
  hexToHsva,
  color as handleColor,
  ColorResult,
} from '@uiw/color-convert'
import Swatch, { SwatchPresetColor } from '@uiw/react-color-swatch'
import { useEffect } from 'react'
import { Select } from './Select'

const PRESET_COLORS = [
  '#D0021B',
  '#F5A623',
  '#f8e61b',
  '#8B572A',
  '#7ED321',
  '#417505',
  '#BD10E0',
  '#9013FE',
  '#4A90E2',
  '#50E3C2',
  '#B8E986',
  '#000000',
  '#4A4A4A',
  '#9B9B9B',
  '#FFFFFF',
]

export interface SketchProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'color'> {
  prefixCls?: string
  width?: number
  color?: string | HsvaColor
  presetColors?: false | SwatchPresetColor[]
  editableDisable?: boolean
  disableAlpha?: boolean
  onChange?: (newShade: ColorResult) => void
}

const Bar = (props: PointerProps) => (
  <div
    style={{
      boxShadow: 'rgb(0 0 0 / 60%) 0px 0px 2px',
      width: 4,
      top: 1,
      bottom: 1,
      left: props.left,
      borderRadius: 1,
      position: 'absolute',
      backgroundColor: '#fff',
    }}
  />
)

const Sketch = React.forwardRef<HTMLDivElement, SketchProps>(function Sketch(props, ref) {
  const {
    prefixCls = 'w-color-sketch',
    className,
    onChange,
    width = 218,
    presetColors = PRESET_COLORS,
    color,
    editableDisable = true,
    disableAlpha = false,
    style,
    ...other
  } = props
  const [mode, setMode] = useState<'hex' | 'rgba' | 'hsla'>('hex')
  const [hsva, setHsva] = useState({ h: 209, s: 36, v: 90, a: 1 })
  useEffect(() => {
    if (typeof color === 'string' && validHex(color)) {
      setHsva(hexToHsva(color))
    }
    if (typeof color === 'object') {
      setHsva(color)
    }
  }, [color])

  const handleChange = (hsv: HsvaColor) => {
    setHsva(hsv)
    onChange && onChange(handleColor(hsv))
  }

  const handleHex = (value: string | number, evn: React.ChangeEvent<HTMLInputElement>) => {
    if (typeof value === 'string' && validHex(value) && /(3|6)/.test(String(value.length))) {
      handleChange(hexToHsva(value))
    }
  }
  const handleAlphaChange = (newAlpha: { a: number }) => handleChange({ ...hsva, ...{ a: newAlpha.a } })
  const handleSaturationChange = (newColor: HsvaColor) => handleChange({ ...hsva, ...newColor, a: hsva.a })
  const styleMain = {
    '--sketch-background': 'rgb(255, 255, 255)',
    '--sketch-box-shadow': 'rgb(0 0 0 / 15%) 0px 0px 0px 1px, rgb(0 0 0 / 15%) 0px 8px 16px',
    '--sketch-swatch-box-shadow': 'rgb(0 0 0 / 15%) 0px 0px 0px 1px inset',
    '--sketch-alpha-box-shadow': 'rgb(0 0 0 / 15%) 0px 0px 0px 1px inset, rgb(0 0 0 / 25%) 0px 0px 4px inset',
    '--sketch-swatch-border-top': '1px solid rgb(238, 238, 238)',
    background: 'var(--sketch-background)',
    borderRadius: 4,
    boxShadow: 'var(--sketch-box-shadow)',
    width,
    ...style,
  } as CSS.Properties<string | number>
  const styleAlpha: CSS.Properties<string | number> = {
    borderRadius: 2,
    background: hsvaToRgbaString(hsva),
    boxShadow: 'var(--sketch-alpha-box-shadow)',
  }
  const styleSwatch: CSS.Properties<string | number> = {
    borderTop: 'var(--sketch-swatch-border-top)',
    paddingTop: 10,
    paddingLeft: 10,
  }
  const styleSwatchRect: CSS.Properties<string | number> = {
    marginRight: 10,
    marginBottom: 10,
    borderRadius: 3,
    boxShadow: 'var(--sketch-swatch-box-shadow)',
  }
  return (
    <div {...other} className={`${prefixCls} ${className || ''}`} ref={ref} style={styleMain}>
      <div style={{ padding: '10px 10px 8px' }}>
        <Saturation hsva={hsva} style={{ width: 'auto', height: 150 }} onChange={handleSaturationChange} />
        <div style={{ display: 'flex', marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            <Hue
              width="auto"
              height={10}
              hue={hsva.h}
              pointer={Bar}
              innerProps={{
                style: { marginLeft: 1, marginRight: 5 },
              }}
              onChange={(newHue) => handleChange({ ...hsva, ...newHue })}
            />
            {!disableAlpha && (
              <Alpha
                width="auto"
                height={10}
                hsva={hsva}
                pointer={Bar}
                style={{ marginTop: 4 }}
                innerProps={{
                  style: { marginLeft: 1, marginRight: 5 },
                }}
                onChange={handleAlphaChange}
              />
            )}
          </div>
          {!disableAlpha && (
            <Alpha
              width={24}
              height={24}
              hsva={hsva}
              radius={2}
              style={{
                marginLeft: 4,
              }}
              bgProps={{ style: { background: 'transparent' } }}
              innerProps={{
                style: styleAlpha,
              }}
              pointer={() => <Fragment />}
            />
          )}
        </div>
      </div>
      {editableDisable && (
        <div className="flex w-full" style={{ padding: '0 10px 3px 10px' }}>
          {mode === 'hex' ? (
            <EditableInput
              label="Hex"
              value={hsvaToHex(hsva).replace(/^#/, '').toLocaleUpperCase()}
              onChange={(evn, val) => handleHex(val, evn)}
              style={{ marginRight: 6, minWidth: 58 }}
            />
          ) : mode === 'hsla' ? (
            <EditableInputHSLA
              hsva={hsva}
              style={{ marginRight: 6 }}
              aProps={!disableAlpha ? {} : false}
              onChange={(result) => handleChange(result.hsva)}
            />
          ) : (
            <RGBA
              hsva={hsva}
              style={{ marginRight: 6 }}
              aProps={!disableAlpha ? {} : false}
              onChange={(result) => handleChange(result.hsva)}
            />
          )}
          <div className="w-16 min-w-16 flex-grow">
            <Select
              theme="node"
              className="border !bg-[#1f2937] border-gray-500"
              value={mode}
              onChange={(value) => setMode(value as 'hex' | 'rgba' | 'hsla')}
              options={[
                { label: 'Hex', value: 'hex' },
                { label: 'HSL', value: 'hsla' },
                { label: 'RGB', value: 'rgba' },
              ]}
            />
          </div>
        </div>
      )}
      {presetColors && presetColors.length > 0 && (
        <Swatch
          style={styleSwatch}
          colors={presetColors}
          color={hsvaToHex(hsva)}
          onChange={(hsvColor) => handleChange(hsvColor)}
          rectProps={{
            style: styleSwatchRect,
          }}
        />
      )}
    </div>
  )
})

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
            'border text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full px-2.5 py-1.5 bg-gray-600 border-gray-500 placeholder-gray-400 text-white h-[34px] cursor-pointer min-w-[120px]',
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
