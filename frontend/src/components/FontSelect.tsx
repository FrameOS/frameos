import { useValues } from 'kea'
import { Select } from './Select'
import { fontsModel } from '../models/fontsModel'
import clsx from 'clsx'
import { useEffect } from 'react'

export interface FontSelectProps {
  value: string
  onChange: (value: string) => void
  className?: string
}

export function FontSelect({ value, onChange, className }: FontSelectProps): JSX.Element {
  const { fonts, fontsOptions, fontLoaded, fontLoading } = useValues(fontsModel)
  const font = fonts.find((font) => font.file === value)
  useEffect(() => {
    if (font) {
      fontsModel.actions.loadFont(font)
    }
  }, [font])
  return (
    <div>
      <Select theme="node" value={value} options={fontsOptions} onChange={onChange} className={clsx(className)} />
      {font && fontLoaded[font.file] ? (
        <div style={{ fontFamily: font.name, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : undefined }}>
          Hello from a font!
        </div>
      ) : null}
    </div>
  )
}
