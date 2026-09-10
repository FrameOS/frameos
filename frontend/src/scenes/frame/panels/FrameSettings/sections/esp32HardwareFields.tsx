import { Group } from 'kea-forms'
import { Field } from '../../../../../components/Field'
import { NumberTextInput } from '../../../../../components/NumberTextInput'
import { Select } from '../../../../../components/Select'
import { Switch } from '../../../../../components/Switch'
import { embeddedPlatforms } from '../../../../../devices'
import type { FrameEmbeddedFlashSize } from '../../../../../types'
import { useFrameSettings } from '../frameSettingsContext'
import {
  ESP32_FLASH_SIZE_OPTIONS,
  ESP32_HARDWARE_PRESET_OPTIONS,
  ESP32_PIN_FIELDS,
  ESP32_SD_CARD_PIN_FIELDS,
  ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET,
  ESP32_WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET,
  esp32HardwarePresetConfig,
  esp32PinLayoutForPreset,
  esp32PinLayoutPresetOptions,
  esp32PinLayoutPresetValue,
  esp32RecommendedPinLayout,
  esp32SdCardPinsForPreset,
  esp32SdCardPresetValue,
  normalizeEsp32HardwarePreset,
  normalizeEsp32PinLayout,
  normalizeEsp32PinNumber,
  normalizeEsp32SdCardAssets,
  normalizeEsp32SdCardFrequency,
  type Esp32Pins,
  type Esp32SdCardAssets,
} from '../esp32Hardware'

/** Platform, flash, GPIO pin layout and SD-card wiring for an embedded board. */
export function Esp32HardwareFields(): JSX.Element {
  const { frameForm, isVirtualPlatform, embeddedHardwarePreset, setEsp32HardwarePreset, setEsp32HardwarePresetCustom } =
    useFrameSettings()
  return (
    <>
      <Group name="embedded">
        <Field name="platform" label="Platform">
          <Select name="embedded.platform" options={embeddedPlatforms} />
        </Field>
        {isVirtualPlatform ? null : (
          <>
            <Field
              name="hardwarePreset"
              label="Hardware preset"
              tooltip="Board presets apply flash, PSRAM, display GPIO, and SD-card asset wiring together."
            >
              {({ value }) => (
                <Select
                  name="embedded.hardwarePreset"
                  value={normalizeEsp32HardwarePreset(value ?? frameForm.device_config?.hardwarePreset)}
                  options={ESP32_HARDWARE_PRESET_OPTIONS}
                  onChange={(nextPreset) => setEsp32HardwarePreset(normalizeEsp32HardwarePreset(nextPreset))}
                />
              )}
            </Field>
            <Field
              name="flashSize"
              label="Flash size"
              tooltip="ESP32 module flash size. 4MB builds use a single app slot and cannot update over the air."
            >
              {({ value, onChange }) => (
                <Select
                  name="embedded.flashSize"
                  value={(value as FrameEmbeddedFlashSize | undefined) ?? '8MB'}
                  options={ESP32_FLASH_SIZE_OPTIONS}
                  onChange={(nextFlashSize) => {
                    const flashSize = nextFlashSize as FrameEmbeddedFlashSize
                    const presetConfig = esp32HardwarePresetConfig(embeddedHardwarePreset)
                    if (presetConfig && flashSize !== presetConfig.flashSize) {
                      setEsp32HardwarePresetCustom({
                        embedded: { ...(frameForm.embedded ?? {}), flashSize },
                      })
                    } else {
                      onChange(flashSize)
                    }
                  }}
                />
              )}
            </Field>
          </>
        )}
      </Group>
      {isVirtualPlatform ? null : (
        <Group name="device_config">
          <Field
            name="pins"
            label="GPIO pin layout"
            tooltip="GPIO numbers for the e-paper SPI wiring. Use -1 for optional pins that are not connected."
          >
            {({ value, onChange }) => {
              const pins = normalizeEsp32PinLayout(
                value as Esp32Pins | undefined,
                frameForm.device,
                embeddedHardwarePreset
              )
              const preset = esp32PinLayoutPresetValue(pins)
              const recommended = esp32RecommendedPinLayout(frameForm.device, embeddedHardwarePreset)
              return (
                <div className="space-y-3">
                  <Select
                    value={preset}
                    options={esp32PinLayoutPresetOptions(frameForm.device)}
                    onChange={(nextPreset) => {
                      if (nextPreset === 'waveshare-photopainter') {
                        setEsp32HardwarePreset(ESP32_WAVESHARE_PHOTOPAINTER_HARDWARE_PRESET)
                        return
                      }
                      if (nextPreset === 'waveshare-13in3e6') {
                        setEsp32HardwarePreset(ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET)
                        return
                      }
                      const layout = esp32PinLayoutForPreset(nextPreset, frameForm.device, embeddedHardwarePreset)
                      if (layout) {
                        if (embeddedHardwarePreset !== 'custom') {
                          setEsp32HardwarePresetCustom({
                            device_config: { ...(frameForm.device_config ?? {}), pins: layout },
                          })
                        } else {
                          onChange(layout)
                        }
                      }
                    }}
                  />
                  <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                    {ESP32_PIN_FIELDS.map(({ key, label }) => (
                      <label key={key} className="space-y-1">
                        <span className="frame-tool-muted block text-xs font-semibold">{label}</span>
                        <NumberTextInput
                          value={pins[key]}
                          placeholder={String(recommended[key])}
                          onChange={(nextValue) => {
                            const fallback = key === 'cs2' || key === 'pwr' ? -1 : pins[key]
                            const nextPins = {
                              ...pins,
                              [key]: normalizeEsp32PinNumber(nextValue, fallback),
                            }
                            if (embeddedHardwarePreset !== 'custom') {
                              setEsp32HardwarePresetCustom({
                                device_config: { ...(frameForm.device_config ?? {}), pins: nextPins },
                              })
                            } else {
                              onChange(nextPins)
                            }
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )
            }}
          </Field>
          <Field
            name="sdCardAssets"
            label="SD card assets"
            tooltip="Mount a FAT32 SD card at /srv/assets so local image and font assets work on this frame."
          >
            {({ value, onChange }) => {
              const sdCardAssets = normalizeEsp32SdCardAssets(value as Esp32SdCardAssets | undefined)
              const preset = esp32SdCardPresetValue(sdCardAssets)
              const updateSdCardAssets = (nextValues: Partial<Esp32SdCardAssets>) => {
                onChange({
                  ...sdCardAssets,
                  ...nextValues,
                  mountPath: '/srv/assets',
                })
              }
              return (
                <div className="space-y-3">
                  <Switch
                    label="Mount FAT32 SD card at /srv/assets"
                    value={sdCardAssets.enabled}
                    onChange={(enabled) => {
                      if (embeddedHardwarePreset !== 'custom' && !enabled) {
                        setEsp32HardwarePresetCustom({
                          device_config: {
                            ...(frameForm.device_config ?? {}),
                            sdCardAssets: { ...sdCardAssets, enabled, mountPath: '/srv/assets' },
                          },
                        })
                      } else {
                        updateSdCardAssets({ enabled })
                      }
                    }}
                    fullWidth
                  />
                  {sdCardAssets.enabled ? (
                    <>
                      <Select
                        value={preset}
                        options={[
                          { value: 'custom', label: 'Custom pins' },
                          {
                            value: 'waveshare_esp32_s3_photopainter',
                            label: 'Waveshare ESP32-S3 PhotoPainter',
                          },
                          {
                            value: ESP32_WAVESHARE_13IN3E6_HARDWARE_PRESET,
                            label: 'Waveshare ESP32-S3 ePaper 13.3E6',
                          },
                        ]}
                        onChange={(nextPreset) => {
                          const nextSdCardAssets = {
                            preset: nextPreset as Esp32SdCardAssets['preset'],
                            pins: esp32SdCardPinsForPreset(nextPreset),
                          }
                          if (embeddedHardwarePreset !== 'custom' && nextPreset !== embeddedHardwarePreset) {
                            setEsp32HardwarePresetCustom({
                              device_config: {
                                ...(frameForm.device_config ?? {}),
                                sdCardAssets: {
                                  ...sdCardAssets,
                                  ...nextSdCardAssets,
                                  mountPath: '/srv/assets',
                                },
                              },
                            })
                          } else {
                            updateSdCardAssets(nextSdCardAssets)
                          }
                        }}
                      />
                      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                        {ESP32_SD_CARD_PIN_FIELDS.map(({ key, label }) => (
                          <label key={key} className="space-y-1">
                            <span className="frame-tool-muted block text-xs font-semibold">{label}</span>
                            <NumberTextInput
                              value={sdCardAssets.pins[key]}
                              placeholder={String(esp32SdCardPinsForPreset(preset)[key])}
                              onChange={(nextValue) => {
                                const nextSdCardAssets = {
                                  preset: 'custom',
                                  pins: {
                                    ...sdCardAssets.pins,
                                    [key]: normalizeEsp32PinNumber(nextValue, sdCardAssets.pins[key]),
                                  },
                                } as Partial<Esp32SdCardAssets>
                                if (embeddedHardwarePreset !== 'custom') {
                                  setEsp32HardwarePresetCustom({
                                    device_config: {
                                      ...(frameForm.device_config ?? {}),
                                      sdCardAssets: {
                                        ...sdCardAssets,
                                        ...nextSdCardAssets,
                                        mountPath: '/srv/assets',
                                      },
                                    },
                                  })
                                } else {
                                  updateSdCardAssets(nextSdCardAssets)
                                }
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="space-y-1 block">
                        <span className="frame-tool-muted block text-xs font-semibold">Max frequency (kHz)</span>
                        <NumberTextInput
                          value={sdCardAssets.maxFrequencyKHz}
                          placeholder="20000"
                          onChange={(nextValue) => {
                            const maxFrequencyKHz = normalizeEsp32SdCardFrequency(nextValue)
                            if (embeddedHardwarePreset !== 'custom' && maxFrequencyKHz !== 20000) {
                              setEsp32HardwarePresetCustom({
                                device_config: {
                                  ...(frameForm.device_config ?? {}),
                                  sdCardAssets: {
                                    ...sdCardAssets,
                                    maxFrequencyKHz,
                                    mountPath: '/srv/assets',
                                  },
                                },
                              })
                            } else {
                              updateSdCardAssets({ maxFrequencyKHz })
                            }
                          }}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              )
            }}
          </Field>
        </Group>
      )}
    </>
  )
}
