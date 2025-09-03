import React, { useState, useRef, Fragment, forwardRef, useMemo, useEffect } from 'react'
import { clsx } from 'clsx'
import { Tooltip } from './Tooltip'
import { frameLogic } from '../scenes/frame/frameLogic'
import { withCustomPalette } from '../devices'

import type * as CSS from 'csstype'
import Saturation from '@uiw/react-color-saturation'
import Alpha, { PointerProps } from '@uiw/react-color-alpha'
import Hue from '@uiw/react-color-hue'
import {
  validHex,
  HsvaColor,
  hsvaToHex,
  hsvaToRgbaString,
  RgbaColor,
  hexToHsva,
  color as handleColor,
  ColorResult,
  hsvaToHsla,
  hslaToHsva,
  hsvaToRgba,
  rgbaToHsva,
  type HslaColor,
} from '@uiw/color-convert'
import Swatch, { SwatchPresetColor } from '@uiw/react-color-swatch'
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
const getNumberValue = (value: string) => Number(String(value).replace(/%/g, ''))

export interface EditableInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  prefixCls?: string
  value?: string | number
  label?: React.ReactNode
  labelStyle?: CSS.Properties<string | number>
  placement?: 'top' | 'left' | 'bottom' | 'right'
  inputStyle?: CSS.Properties<string | number>
  onChange?: (evn: React.ChangeEvent<HTMLInputElement>, value: string | number) => void
  renderInput?: (
    props: React.InputHTMLAttributes<HTMLInputElement>,
    ref: React.Ref<HTMLInputElement>
  ) => React.ReactNode
}

const EditableInput = React.forwardRef<HTMLInputElement, EditableInputProps>(function EditableInput(props, ref) {
  const {
    prefixCls = 'w-color-editable-input',
    placement = 'bottom',
    label,
    value: initValue,
    className,
    style,
    labelStyle,
    inputStyle,
    onChange,
    onBlur,
    renderInput,
    ...other
  } = props
  const [value, setValue] = useState<string | number | undefined>(initValue)
  const isFocus = useRef(false)

  useEffect(() => {
    if (props.value !== value) {
      setValue(props.value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value])

  function handleChange(evn: React.ChangeEvent<HTMLInputElement>, valInit?: string) {
    const value = (valInit ?? evn.target.value).trim().replace(/^#/, '')
    if (validHex(value)) {
      onChange && onChange(evn, value)
    }
    const val = getNumberValue(value)
    if (!isNaN(val)) {
      onChange && onChange(evn, val)
    }
    setValue(value)
  }
  function handleBlur(evn: React.FocusEvent<HTMLInputElement>) {
    isFocus.current = false
    setValue(props.value)
    onBlur && onBlur(evn)
  }
  const placementStyle: CSS.Properties<string | number> = {}
  if (placement === 'bottom') {
    placementStyle['flexDirection'] = 'column'
  }
  if (placement === 'top') {
    placementStyle['flexDirection'] = 'column-reverse'
  }
  if (placement === 'left') {
    placementStyle['flexDirection'] = 'row-reverse'
  }

  const wrapperStyle: CSS.Properties<string | number> = {
    '--editable-input-label-color': 'rgb(153, 153, 153)',
    '--editable-input-box-shadow': 'rgb(204 204 204) 0px 0px 0px 1px inset',
    '--editable-input-color': '#666',
    position: 'relative',
    alignItems: 'center',
    display: 'flex',
    fontSize: 11,
    ...placementStyle,
    ...style,
  } as CSS.Properties<string | number>

  const editableStyle: CSS.Properties<string | number> = {
    width: '100%',
    paddingTop: 2,
    paddingBottom: 2,
    paddingLeft: 3,
    paddingRight: 3,
    fontSize: 11,
    background: 'transparent',
    boxSizing: 'border-box',
    border: 'none',
    color: 'var(--editable-input-color)',
    boxShadow: 'var(--editable-input-box-shadow)',
    ...inputStyle,
  } as CSS.Properties<string | number>

  const inputProps: React.InputHTMLAttributes<HTMLInputElement> = {
    value,
    onChange: handleChange,
    onBlur: handleBlur,
    autoComplete: 'off',
    onFocus: () => (isFocus.current = true),
    ...other,
    style: editableStyle,
  }
  return (
    <div className={[prefixCls, className || ''].filter(Boolean).join(' ')} style={wrapperStyle}>
      {renderInput ? renderInput(inputProps, ref) : <input ref={ref} {...inputProps} />}
      {label && (
        <span
          style={{
            color: 'var(--editable-input-label-color)',
            textTransform: 'capitalize',
            ...labelStyle,
          }}
          children={label}
        />
      )}
    </div>
  )
})

export interface EditableInputRGBAProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  prefixCls?: string
  hsva: HsvaColor
  rgba?: RgbaColor
  placement?: 'top' | 'left' | 'bottom' | 'right'
  rProps?: EditableInputProps
  gProps?: EditableInputProps
  bProps?: EditableInputProps
  aProps?: false | EditableInputProps
  onChange?: (color: ColorResult) => void
}

const EditableInputRGBA = React.forwardRef<HTMLDivElement, EditableInputRGBAProps>((props, ref) => {
  const {
    prefixCls = 'w-color-editable-input-rgba',
    hsva,
    rgba: rgbaProp,
    placement = 'bottom',
    rProps = {},
    gProps = {},
    bProps = {},
    aProps = {},
    className,
    style,
    onChange,
    ...other
  } = props
  const rgba = (rgbaProp ?? (hsva ? hsvaToRgba(hsva) : {})) as RgbaColor
  function handleBlur(evn: React.FocusEvent<HTMLInputElement>) {
    const value = Number(evn.target.value)
    if (value && value > 255) {
      evn.target.value = '255'
    }
    if (value && value < 0) {
      evn.target.value = '0'
    }
  }
  const coerceNumber = (val: string | number) => {
    if (typeof val === 'number') return val
    const cleaned = String(val)
      .replace(',', '.')
      .replace(/[^\d.]+/g, '')
    const num = parseFloat(cleaned)
    return Number.isNaN(num) ? null : num
  }

  const handleChange = (
    value: string | number,
    type: 'r' | 'g' | 'b' | 'a',
    evn: React.ChangeEvent<HTMLInputElement>
  ) => {
    const num0 = coerceNumber(value)
    if (num0 === null) return
    let num = num0

    if (type === 'a') {
      // A in RGBA is 0–1 in this component -> accept 0–100 too just in case
      if (num > 1) num = Math.min(100, num) / 100
      num = Math.max(0, Math.min(1, num))
      onChange?.(handleColor(rgbaToHsva({ ...rgba, a: num })))
      return
    }

    // r/g/b 0–255
    if (num > 255) {
      num = 255
      evn.target.value = '255'
    }
    if (num < 0) {
      num = 0
      evn.target.value = '0'
    }

    if (type === 'r') onChange?.(handleColor(rgbaToHsva({ ...rgba, r: num })))
    if (type === 'g') onChange?.(handleColor(rgbaToHsva({ ...rgba, g: num })))
    if (type === 'b') onChange?.(handleColor(rgbaToHsva({ ...rgba, b: num })))
  }

  return (
    <div
      ref={ref}
      className={[prefixCls, className || ''].filter(Boolean).join(' ')}
      {...other}
      style={{
        fontSize: 11,
        display: 'flex',
        ...style,
      }}
    >
      <EditableInput
        label="R"
        value={rgba.r || 0}
        onBlur={handleBlur}
        placement={placement}
        onChange={(evn, val) => handleChange(val, 'r', evn)}
        {...rProps}
        style={{ ...rProps.style }}
      />
      <EditableInput
        label="G"
        value={rgba.g || 0}
        onBlur={handleBlur}
        placement={placement}
        onChange={(evn, val) => handleChange(val, 'g', evn)}
        {...gProps}
        style={{ marginLeft: 5, ...gProps.style }}
      />
      <EditableInput
        label="B"
        value={rgba.b || 0}
        onBlur={handleBlur}
        placement={placement}
        onChange={(evn, val) => handleChange(val, 'b', evn)}
        {...bProps}
        style={{ marginLeft: 5, ...bProps.style }}
      />
      {aProps && (
        <EditableInput
          label="A"
          value={rgba.a ? parseInt(String(rgba.a * 100), 10) : 0}
          onBlur={handleBlur}
          placement={placement}
          onChange={(evn, val) => handleChange(val, 'a', evn)}
          {...aProps}
          style={{ marginLeft: 5, ...aProps.style }}
        />
      )}
    </div>
  )
})

EditableInputRGBA.displayName = 'EditableInputRGBA'

export interface EditableInputHSLAProps extends Omit<EditableInputRGBAProps, 'rProps' | 'gProps' | 'bProps'> {
  hsla?: HslaColor
  hProps?: EditableInputRGBAProps['gProps']
  sProps?: EditableInputRGBAProps['gProps']
  lProps?: EditableInputRGBAProps['gProps']
  aProps?: false | EditableInputRGBAProps['aProps']
  onChangeHSLA?: (next: HslaColor, changed: 'h' | 's' | 'l' | 'a') => void
}
const EditableInputHSLA = React.forwardRef<HTMLDivElement, EditableInputHSLAProps>(function EditableInputHSLA(
  props,
  ref
) {
  const {
    prefixCls = 'w-color-editable-input-hsla',
    hsva,
    hsla: hslaProp,
    hProps = {},
    sProps = {},
    lProps = {},
    aProps = {},
    className,
    onChange,
    onChangeHSLA,
    ...other
  } = props
  const hsla = (hslaProp ?? (hsva ? hsvaToHsla(hsva) : { h: 0, s: 0, l: 0, a: 0 })) as HslaColor

  const coerceNumber = (val: string | number) => {
    if (typeof val === 'number') return val
    const cleaned = String(val)
      .replace(',', '.')
      .replace(/[^\d.]+/g, '')
    const num = parseFloat(cleaned)
    return Number.isNaN(num) ? null : num
  }

  const handleChange = (
    value: string | number,
    type: 'h' | 's' | 'l' | 'a',
    _evn: React.ChangeEvent<HTMLInputElement>
  ) => {
    const num = coerceNumber(value)
    if (num === null) return

    if (type === 'h') {
      const h = Math.max(0, Math.min(360, num))
      onChangeHSLA?.({ ...hsla, h }, 'h')
      return
    }
    if (type === 's') {
      const s = Math.max(0, Math.min(100, num))
      onChangeHSLA?.({ ...hsla, s }, 's')
      return
    }
    if (type === 'l') {
      const l = Math.max(0, Math.min(100, num))
      onChangeHSLA?.({ ...hsla, l }, 'l')
      return
    }
    if (type === 'a') {
      let a = num
      if (a > 1) a = Math.min(100, a) / 100
      a = Math.max(0, Math.min(1, a))
      onChangeHSLA?.({ ...hsla, a }, 'a')
    }
  }

  let aPropsObj: false | EditableInputProps =
    aProps == false
      ? false
      : {
          label: 'A',
          value: Math.round(hsla.a * 100) / 100,
          ...aProps,
          onChange: (evn, val) => handleChange(val, 'a', evn),
        }
  return (
    <EditableInputRGBA
      ref={ref}
      hsva={hsva}
      rProps={{
        label: 'H',
        value: Math.round(hsla.h),
        ...hProps,
        onChange: (evn, val) => handleChange(val, 'h', evn),
      }}
      gProps={{
        label: 'S',
        value: `${Math.round(hsla.s)}%`,
        ...sProps,
        onChange: (evn, val) => handleChange(val, 's', evn),
      }}
      bProps={{
        label: 'L',
        value: `${Math.round(hsla.l)}%`,
        ...lProps,
        onChange: (evn, val) => handleChange(val, 'l', evn),
      }}
      aProps={aPropsObj}
      className={[prefixCls, className || ''].filter(Boolean).join(' ')}
      {...other}
    />
  )
})

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

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

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
  const [hsva, setHsva] = useState<HsvaColor>({ h: 209, s: 36, v: 90, a: 1 })
  const [hslaState, setHslaState] = useState<HslaColor>(hsvaToHsla(hsva))
  const [rgbaState, setRgbaState] = useState<RgbaColor>(hsvaToRgba(hsva))

  // sticky hue: only change when user edits Hue (slider or H input) or when a brand new color is set (hex/swatch/prop/RGB edits)
  const lastHueRef = useRef<number>(hsva.h)
  const lastEmitHexRef = useRef<string | null>(null)
  const normHue = (h: number) => ((h % 360) + 360) % 360

  // --- central state propagation ---
  type HueSource = 'hue' | 'other'

  const propagate = (nextHsva: HsvaColor, source: HueSource) => {
    let hue = lastHueRef.current
    if (source === 'hue') {
      hue = lastHueRef.current = normHue(nextHsva.h)
    }

    const fixedHsva: HsvaColor = { ...nextHsva, h: hue }
    const hslaRaw = hsvaToHsla(fixedHsva)
    const fixedHsla: HslaColor = { ...hslaRaw, h: hue }
    const fixedRgba = hsvaToRgba(fixedHsva)

    setHsva(fixedHsva)
    setHslaState(fixedHsla)
    setRgbaState(fixedRgba)

    // remember what we just told the parent (canonicalized)
    const emittedHex = hsvaToHex(fixedHsva).toLowerCase()
    lastEmitHexRef.current = emittedHex

    onChange?.(handleColor(fixedHsva))
  }

  useEffect(() => {
    if (color == null) return

    let next: HsvaColor | null = null
    if (typeof color === 'string' && validHex(color)) next = hexToHsva(color)
    else if (typeof color === 'object') next = color as HsvaColor
    if (!next) return

    const canonicalIncoming = hsvaToHex(next).toLowerCase()

    if (canonicalIncoming === lastEmitHexRef.current) {
      // Just our own echo — keep sticky hue
      propagate({ ...next, h: lastHueRef.current }, 'other')
      return
    }

    // Truly external change.
    propagate(next, 'hue')
  }, [color])

  // --- conversions from editors ---

  // HSLA editor -> keep sticky hue unless user changed 'h'
  const updateFromHSLA = (nextHSLA: HslaColor, changed: 'h' | 's' | 'l' | 'a') => {
    setHslaState(nextHSLA)
    const next = hslaToHsva(nextHSLA)

    // don’t let conversions reset hue — enforce sticky
    if (changed === 'h') {
      propagate({ ...next, h: next.h }, 'hue')
    } else {
      propagate({ ...next, h: lastHueRef.current }, 'other')
    }
  }

  // RGBA editor -> ADOPT the hue derived from RGB (do NOT force sticky hue here), so R/G/B edits don't mutate other channels
  const updateFromRGBA = (nextRGBA: RgbaColor) => {
    setRgbaState(nextRGBA)
    const next = rgbaToHsva(nextRGBA)
    // treat this like a direct hue change: accept next.h and update sticky hue
    propagate(next, 'hue')
  }

  // Hex editor
  const handleHex = (value: string | number) => {
    if (typeof value === 'string' && validHex(value) && /(3|6)/.test(String(value.length))) {
      const next = hexToHsva(value)
      propagate(next, 'hue') // new color => adopt its hue
    }
  }

  // Saturation square (HSV-based): keep sticky hue unless user moves the Hue bar
  const handleSaturationChange = (newColor: HsvaColor) => {
    propagate({ ...hsva, ...newColor, h: lastHueRef.current, a: hsva.a }, 'other')
  }

  // Alpha slider: does not affect hue
  const handleAlphaChange = (newAlpha: { a: number }) => {
    propagate({ ...hsva, a: newAlpha.a, h: lastHueRef.current }, 'other')
  }

  // ---- Arrow-key nudging helpers ----
  const nudgeHSLA = (channel: 'h' | 's' | 'l' | 'a', delta: number) => {
    const cur = hslaState
    const hsla = { ...cur }
    if (channel === 'h') {
      hsla.h = (((hsla.h + delta) % 360) + 360) % 360
    } else if (channel === 's') {
      hsla.s = clamp(hsla.s + delta, 0, 100)
    } else if (channel === 'l') {
      hsla.l = clamp(hsla.l + delta, 0, 100)
    } else if (channel === 'a') {
      hsla.a = clamp(parseFloat((hsla.a + delta).toFixed(3)), 0, 1)
    }
    updateFromHSLA(hsla, channel)
    return { hsla }
  }

  const nudgeRGBA = (channel: 'r' | 'g' | 'b' | 'a', delta: number) => {
    const rgba = { ...rgbaState } as { r: number; g: number; b: number; a: number }
    if (channel === 'r') rgba.r = clamp(Math.round(rgba.r + delta), 0, 255)
    else if (channel === 'g') rgba.g = clamp(Math.round(rgba.g + delta), 0, 255)
    else if (channel === 'b') rgba.b = clamp(Math.round(rgba.b + delta), 0, 255)
    else if (channel === 'a') rgba.a = clamp(parseFloat((rgba.a + delta).toFixed(3)), 0, 1)
    updateFromRGBA(rgba)
    return { rgba }
  }

  // Formatters so the focused input value changes right away (even while focused).
  const formatHSLA = (channel: 'h' | 's' | 'l' | 'a', hsla: { h: number; s: number; l: number; a: number }) => {
    if (channel === 'h') return String(Math.round(hsla.h))
    if (channel === 'a') return (Math.round(hsla.a * 100) / 100).toFixed(2)
    // s & l need a % suffix
    return `${Math.round(channel === 's' ? hsla.s : hsla.l)}%`
  }
  const formatRGBA = (channel: 'r' | 'g' | 'b' | 'a', rgba: { r: number; g: number; b: number; a: number }) => {
    if (channel === 'a') return (Math.round(rgba.a * 100) / 100).toFixed(2)
    return String(channel === 'r' ? rgba.r : channel === 'g' ? rgba.g : rgba.b)
  }

  // Per-field key handlers.
  const handleHSLAKey = (channel: 'h' | 's' | 'l' | 'a') => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? +1 : -1
    const base =
      channel === 'a'
        ? e.shiftKey
          ? 0.1
          : e.altKey
          ? 0.005
          : 0.01
        : channel === 'h'
        ? e.shiftKey
          ? 10
          : 1
        : e.shiftKey
        ? 10
        : 1
    const { hsla } = nudgeHSLA(channel, dir * base)
    const val = formatHSLA(channel, hsla)
    const input = e.currentTarget
    input.value = val
    const end = val.endsWith('%') ? val.length - 1 : val.length
    try {
      input.setSelectionRange(end, end)
      window.setTimeout(() => {
        input.setSelectionRange(end, end)
      }, 1)
    } catch {}
  }

  const handleRGBAKey = (channel: 'r' | 'g' | 'b' | 'a') => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? +1 : -1
    const base = channel === 'a' ? (e.shiftKey ? 0.1 : e.altKey ? 0.005 : 0.01) : e.shiftKey ? 10 : 1
    const { rgba } = nudgeRGBA(channel, dir * base)
    const val = formatRGBA(channel, rgba)
    const input = e.currentTarget
    input.value = val
    const end = val.length
    try {
      input.setSelectionRange(end, end)
    } catch {}
  }

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
        {/* The Saturation square is HSV-based; we feed it our derived hsva with sticky hue */}
        <Saturation hsva={hsva} style={{ width: 'auto', height: 150 }} onChange={handleSaturationChange} />
        <div style={{ display: 'flex', marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            <Hue
              width="auto"
              height={10}
              hue={lastHueRef.current /* slider reflects sticky hue */}
              pointer={Bar}
              innerProps={{
                style: { marginLeft: 1, marginRight: 5 },
              }}
              onChange={(newHue) => {
                // user explicitly changed hue
                propagate({ ...hsva, ...newHue }, 'hue')
              }}
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
              onChange={(evn, val) => handleHex(val)}
              style={{ marginRight: 6, minWidth: 58 }}
            />
          ) : mode === 'hsla' ? (
            <EditableInputHSLA
              hsva={hsva}
              hsla={hslaState}
              style={{ marginRight: 6 }}
              aProps={!disableAlpha ? { onKeyDown: handleHSLAKey('a') } : false}
              hProps={{ onKeyDown: handleHSLAKey('h') }}
              sProps={{ onKeyDown: handleHSLAKey('s') }}
              lProps={{ onKeyDown: handleHSLAKey('l') }}
              onChangeHSLA={(next, changed) => updateFromHSLA(next, changed)}
            />
          ) : (
            <EditableInputRGBA
              hsva={hsva}
              rgba={rgbaState}
              style={{ marginRight: 6 }}
              aProps={!disableAlpha ? { onKeyDown: handleRGBAKey('a') } : false}
              rProps={{ onKeyDown: handleRGBAKey('r') }}
              gProps={{ onKeyDown: handleRGBAKey('g') }}
              bProps={{ onKeyDown: handleRGBAKey('b') }}
              onChange={(result) => {
                updateFromRGBA((result as ColorResult).rgba!)
              }}
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
          onChange={(hsvColor) => {
            // a swatch is a fresh color: adopt its hue
            propagate(hsvColor, 'hue')
          }}
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
