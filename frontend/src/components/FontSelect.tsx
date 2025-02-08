import { useValues } from 'kea'
import { Select } from './Select'
import { fontsModel } from '../models/fontsModel'
import clsx from 'clsx'
import { useEffect } from 'react'

export interface FontSelectProps {
  value: string
  onChange: (value: string) => void
  className?: string
  theme?: 'node' | 'full'
}

export function FontSelect({ value, onChange, className, theme }: FontSelectProps): JSX.Element {
  const { fonts, fontsByNameOptions, weightsByNameOptions, fontsOptions, fontLoaded, fontLoading } =
    useValues(fontsModel)
  const font = fonts.find((font) => font.file === value)

  useEffect(() => {
    if (font && !fontLoaded[font.file] && !fontLoading[font.file]) {
      fontsModel.actions.loadFont(font)
    }
  }, [font, fontLoaded, fontLoading])

  return (
    <div className="w-full">
      <div className="w-full @md:flex @md:gap-2">
        <Select
          theme={theme}
          value={font?.name || ''}
          options={fontsByNameOptions}
          onChange={(name) => {
            const matchingFonts = fonts.filter((font) => font.name === name)
            if (matchingFonts.length > 0) {
              // find a font with the closest "weight" and "italic" values
              matchingFonts.sort((a, b) => {
                const aDiff =
                  Math.abs(a.weight - (font?.weight ?? 400)) + (a.italic === (font?.italic ?? false) ? 0 : 500)
                const bDiff =
                  Math.abs(b.weight - (font?.weight ?? 400)) + (b.italic === (font?.italic ?? false) ? 0 : 500)
                return aDiff - bDiff
              })
              onChange(matchingFonts[0].file)
            } else {
              onChange('')
            }
          }}
          className={clsx('@md:w-2/3', className)}
        />
        {font?.name ? (
          <Select
            theme={theme}
            value={value || ''}
            options={weightsByNameOptions[font?.name]}
            onChange={onChange}
            className={clsx('@md:w-1/3', className)}
          />
        ) : null}
      </div>
      {font ? (
        <div
          style={{ fontFamily: font.name, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : undefined }}
          className="mt-2"
          contentEditable
        >
          What did the quick brown fox say? Ding ding... 1 2 3 4 5
        </div>
      ) : null}
    </div>
  )
}
