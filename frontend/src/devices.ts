import { Option } from './components/Select'
import { Palette } from './types'

// To generate a new version:
// cd backend && python3 list_devices.py

export const devices: Option[] = [
  { value: 'web_only', label: 'Web only' },
  { value: 'framebuffer', label: 'HDMI / Framebuffer' },
  { value: 'http.upload', label: 'HTTP upload' },
  { value: 'pimoroni.inky_impression_7', label: 'Pimoroni Inky Impression - 7.3" 2025 edition' },
  { value: 'pimoroni.inky_impression_13', label: 'Pimoroni Inky Impression - 13.3" 2025 edition' },
  { value: 'pimoroni.inky_impression', label: 'Pimoroni Inky Impression - all others' },
  { value: 'pimoroni.inky_python', label: 'Pimoroni Inky other (Python driver)' },
  { value: 'pimoroni.hyperpixel2r', label: 'Pimoroni HyperPixel 2.1" Round' },
  { value: 'waveshare.EPD_1in02d', label: 'Waveshare 1.02" (D) 128x80 Black/White' },
  { value: 'waveshare.EPD_1in54_DES', label: 'Waveshare 1.54" (DES) 152x152 Black/White' },
  { value: 'waveshare.EPD_1in54c', label: 'Waveshare 1.54" (C) 152x152 Black/White/Yellow' },
  { value: 'waveshare.EPD_1in54', label: 'Waveshare 1.54" 200x200 Black/White' },
  { value: 'waveshare.EPD_1in54_V2', label: 'Waveshare 1.54" (V2) 200x200 Black/White' },
  { value: 'waveshare.EPD_1in54b', label: 'Waveshare 1.54" (B) 200x200 Black/White/Red' },
  { value: 'waveshare.EPD_1in54b_V2', label: 'Waveshare 1.54" (B V2) 200x200 Black/White/Red' },
  { value: 'waveshare.EPD_1in64g', label: 'Waveshare 1.64" (G) 168x168 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in13_DES', label: 'Waveshare 2.13" (DES) 212x104 Black/White' },
  { value: 'waveshare.EPD_2in13b', label: 'Waveshare 2.13" (B) 212x104 Black/White/Red' },
  { value: 'waveshare.EPD_2in13b_V3', label: 'Waveshare 2.13" (B V3) 212x104 Black/White/Red' },
  { value: 'waveshare.EPD_2in13bc', label: 'Waveshare 2.13" (BC) 212x104 Black/White/Yellow' },
  { value: 'waveshare.EPD_2in13c', label: 'Waveshare 2.13" (C) 212x104 Black/White/Yellow' },
  { value: 'waveshare.EPD_2in13d', label: 'Waveshare 2.13" (D) 212x104 Black/White' },
  { value: 'waveshare.EPD_2in13', label: 'Waveshare 2.13" 250x122 Black/White' },
  { value: 'waveshare.EPD_2in13_V2', label: 'Waveshare 2.13" (V2) 250x122 Black/White' },
  { value: 'waveshare.EPD_2in13_V3', label: 'Waveshare 2.13" (V3) 250x122 Black/White' },
  { value: 'waveshare.EPD_2in13_V4', label: 'Waveshare 2.13" (V4) 250x122 Black/White' },
  { value: 'waveshare.EPD_2in13b_V4', label: 'Waveshare 2.13" (B V4) 250x122 Black/White/Red' },
  { value: 'waveshare.EPD_2in13g', label: 'Waveshare 2.13" (G) 250x122 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in13g_V2', label: 'Waveshare 2.13" (G V2) 250x122 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in15b', label: 'Waveshare 2.15" (B) 296x160 Black/White/Red' },
  { value: 'waveshare.EPD_2in15g', label: 'Waveshare 2.15" (G) 296x160 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in36g', label: 'Waveshare 2.36" (G) 296x168 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in66', label: 'Waveshare 2.66" 296x152 Black/White' },
  { value: 'waveshare.EPD_2in66b', label: 'Waveshare 2.66" (B) 296x152 Black/White/Red' },
  { value: 'waveshare.EPD_2in66g', label: 'Waveshare 2.66" (G) 360x184 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_2in7', label: 'Waveshare 2.7" 264x176 4 Grayscale' },
  { value: 'waveshare.EPD_2in7_V2', label: 'Waveshare 2.7" (V2) 264x176 4 Grayscale' },
  { value: 'waveshare.EPD_2in7b', label: 'Waveshare 2.7" (B) 264x176 Black/White/Red' },
  { value: 'waveshare.EPD_2in7b_V2', label: 'Waveshare 2.7" (B V2) 264x176 Black/White/Red' },
  { value: 'waveshare.EPD_2in9', label: 'Waveshare 2.9" 296x128 Black/White' },
  { value: 'waveshare.EPD_2in9_DES', label: 'Waveshare 2.9" (DES) 296x128 Black/White' },
  { value: 'waveshare.EPD_2in9_V2', label: 'Waveshare 2.9" (V2) 296x128 4 Grayscale' },
  { value: 'waveshare.EPD_2in9b', label: 'Waveshare 2.9" (B) 296x128 Black/White/Red' },
  { value: 'waveshare.EPD_2in9b_V3', label: 'Waveshare 2.9" (B V3) 296x128 Black/White/Red' },
  { value: 'waveshare.EPD_2in9b_V4', label: 'Waveshare 2.9" (B V4) 296x128 Black/White/Red' },
  { value: 'waveshare.EPD_2in9bc', label: 'Waveshare 2.9" (BC) 296x128 Black/White/Yellow' },
  { value: 'waveshare.EPD_2in9c', label: 'Waveshare 2.9" (C) 296x128 Black/White/Yellow' },
  { value: 'waveshare.EPD_2in9d', label: 'Waveshare 2.9" (D) 296x128 Black/White' },
  { value: 'waveshare.EPD_3in0g', label: 'Waveshare 3.0" (G) 400x168 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_3in52', label: 'Waveshare 3.52" 360x240 Black/White' },
  { value: 'waveshare.EPD_3in52b', label: 'Waveshare 3.52" (B) 360x240 Black/White/Red' },
  { value: 'waveshare.EPD_3in7', label: 'Waveshare 3.7" 480x280 4 Grayscale' },
  { value: 'waveshare.EPD_4in0e', label: 'Waveshare 4.0" (E) 600x400 Spectra 6 Color' },
  { value: 'waveshare.EPD_4in01f', label: 'Waveshare 4.01" (F) 640x400 7 Color' },
  { value: 'waveshare.EPD_4in2', label: 'Waveshare 4.2" 400x300 4 Grayscale' },
  { value: 'waveshare.EPD_4in2_V2', label: 'Waveshare 4.2" (V2) 400x300 4 Grayscale' },
  { value: 'waveshare.EPD_4in2b', label: 'Waveshare 4.2" (B) 400x300 Black/White/Red' },
  { value: 'waveshare.EPD_4in2b_V2', label: 'Waveshare 4.2" (B V2) 400x300 Black/White/Red' },
  { value: 'waveshare.EPD_4in2b_V2_old', label: 'Waveshare 4.2" (B V2 OLD) 400x300 Black/White/Red' },
  { value: 'waveshare.EPD_4in2bc', label: 'Waveshare 4.2" (BC) 400x300 Black/White/Yellow' },
  { value: 'waveshare.EPD_4in2c', label: 'Waveshare 4.2" (C) 400x300 Black/White/Yellow' },
  { value: 'waveshare.EPD_4in26', label: 'Waveshare 4.26" 800x480 4 Grayscale' },
  { value: 'waveshare.EPD_4in37b', label: 'Waveshare 4.37" (B) 480x176 Black/White/Red' },
  { value: 'waveshare.EPD_4in37g', label: 'Waveshare 4.37" (G) 512x368 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_5in65f', label: 'Waveshare 5.65" (F) 600x448 7 Color' },
  { value: 'waveshare.EPD_5in79', label: 'Waveshare 5.79" 792x272 4 Grayscale' },
  { value: 'waveshare.EPD_5in79b', label: 'Waveshare 5.79" (B) 792x272 Black/White/Red' },
  { value: 'waveshare.EPD_5in79g', label: 'Waveshare 5.79" (G) 792x272 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_5in83', label: 'Waveshare 5.83" 600x448 Black/White' },
  { value: 'waveshare.EPD_5in83b', label: 'Waveshare 5.83" (B) 600x448 Black/White/Red' },
  { value: 'waveshare.EPD_5in83bc', label: 'Waveshare 5.83" (BC) 600x448 Black/White/Yellow' },
  { value: 'waveshare.EPD_5in83c', label: 'Waveshare 5.83" (C) 600x448 Black/White/Yellow' },
  { value: 'waveshare.EPD_5in83_V2', label: 'Waveshare 5.83" (V2) 648x480 Black/White' },
  { value: 'waveshare.EPD_5in83b_V2', label: 'Waveshare 5.83" (B V2) 648x480 Black/White/Red' },
  { value: 'waveshare.EPD_5in84', label: 'Waveshare 5.84" 768x256 Black/White' },
  { value: 'waveshare.EPD_7in3e', label: 'Waveshare 7.3" (E) 800x480 Spectra 6 Color' },
  { value: 'waveshare.EPD_7in3f', label: 'Waveshare 7.3" (F) 800x480 7 Color' },
  { value: 'waveshare.EPD_7in3g', label: 'Waveshare 7.3" (G) 800x480 Black/White/Yellow/Red' },
  { value: 'waveshare.EPD_7in5', label: 'Waveshare 7.5" 640x384 Black/White' },
  { value: 'waveshare.EPD_7in5b', label: 'Waveshare 7.5" (B) 640x384 Black/White/Red' },
  { value: 'waveshare.EPD_7in5bc', label: 'Waveshare 7.5" (BC) 640x384 Black/White/Yellow' },
  { value: 'waveshare.EPD_7in5c', label: 'Waveshare 7.5" (C) 640x384 Black/White/Yellow' },
  { value: 'waveshare.EPD_7in5_V2', label: 'Waveshare 7.5" (V2) 800x480 Black/White' },
  { value: 'waveshare.EPD_7in5_V2_gray', label: 'Waveshare 7.5" (V2 GRAY) 800x480 4 Grayscale' },
  { value: 'waveshare.EPD_7in5b_V2', label: 'Waveshare 7.5" (B V2) 800x480 Black/White/Red' },
  { value: 'waveshare.EPD_7in5b_V2_old', label: 'Waveshare 7.5" (B V2 OLD) 800x480 Black/White/Red' },
  { value: 'waveshare.EPD_7in5_HD', label: 'Waveshare 7.5" (HD) 880x528 Black/White' },
  { value: 'waveshare.EPD_7in5b_HD', label: 'Waveshare 7.5" (B HD) 880x528 Black/White/Red' },
  { value: 'waveshare.EPD_10in2b', label: 'Waveshare 10.2" (B) 960x640 Black/White/Red' },
  { value: 'waveshare.EPD_10in3', label: 'Waveshare 10.3" 1872x1404 16 Grayscale' },
  { value: 'waveshare.EPD_12in48', label: 'Waveshare 12.48" 1304x984 Black/White' },
  { value: 'waveshare.EPD_12in48b', label: 'Waveshare 12.48" (B) 1304x984 Black/White/Red' },
  { value: 'waveshare.EPD_12in48b_V2', label: 'Waveshare 12.48" (B V2) 1304x984 Black/White/Red' },
  { value: 'waveshare.EPD_13in3b', label: 'Waveshare 13.3" (B) 960x680 Black/White/Red' },
  { value: 'waveshare.EPD_13in3k', label: 'Waveshare 13.3" (K) 960x680 Black/White' },
  { value: 'waveshare.EPD_13in3e', label: 'Waveshare 13.3" (E) 1600x1200 Spectra 6 Color' },
]

// TODO: make all of them work with NixOS
const testedNixOs = ['waveshare.EPD_13in3e', 'waveshare.EPD_7in3e']
export const devicesNixOS: Option[] = devices
  .filter((device) => !device.value.startsWith('pimoroni'))
  .map((device) => (testedNixOs.includes(device.value) ? { ...device, label: `${device.label} (tested)` } : device))

const colorNames = ['Black', 'White', 'Yellow', 'Red', 'Blue', 'Green']
export const spectraPalettes: Palette[] = [
  {
    name: 'FrameOS default',
    colorNames,
    colors: [
      '#191426', // Black
      '#b2c1c0', // White
      '#c7bb00', // Yellow
      '#6b1119', // Red
      '#18539a', // Blue
      '#2a5531', // Green
    ],
  },
  {
    name: 'Desaturated',
    colorNames,
    colors: [
      '#000000', // Black
      '#ffffff', // White
      '#ffff00', // Yellow
      '#ff0000', // Red
      '#0000ff', // Blue
      '#00ff00', // Green
    ],
  },
  {
    name: 'Pimoroni Saturated',
    colorNames,
    colors: [
      '#000000', // Black
      '#a1a4a5', // Gray
      '#d0be47', // Yellow
      '#9c484b', // Red
      '#3d3b5e', // Blue
      '#3a5b46', // Green
    ],
  },
  {
    name: 'Old default with more range',
    colorNames,
    colors: [
      '#000000', // Black
      '#ffffff', // White
      '#fff338', // Yellow
      '#bf0000', // Red
      '#6440ff', // Blue
      '#438a1c', // Green
    ],
  },
]

export const withCustomPalette: Record<string, Palette> = {
  'waveshare.EPD_13in3e': spectraPalettes[0],
  'waveshare.EPD_7in3e': spectraPalettes[0],
  'waveshare.EPD_4in0e': spectraPalettes[0],
  'pimoroni.inky_impression_7': spectraPalettes[0],
  'pimoroni.inky_impression_13': spectraPalettes[0],
}

export const nixosPlatforms: Option[] = [{ value: 'pi-zero2', label: 'Raspberry Pi Zero W2' }]

export const luckfoxBuildrootPlatformValues = [
  'RV1103_Luckfox_Pico',
  'RV1103_Luckfox_Pico_Mini',
  'RV1103_Luckfox_Pico_Plus',
  'RV1103_Luckfox_Pico_WebBee',
  'RV1106_Luckfox_Pico_Pro_Max',
  'RV1106_Luckfox_Pico_Ultra',
  'RV1106_Luckfox_Pico_Ultra_W',
  'RV1106_Luckfox_Pico_Pi',
  'RV1106_Luckfox_Pico_Pi_W',
  'RV1106_Luckfox_Pico_86Panel',
  'RV1106_Luckfox_Pico_86Panel_W',
  'RV1106_Luckfox_Pico_Zero',
]

export const luckfoxBuildrootPlatforms: Option[] = luckfoxBuildrootPlatformValues.map((platform) => ({
  value: platform,
  label: platform,
}))

export const buildrootPlatforms: Option[] = [{ value: '', label: '-- Please select --' }, ...luckfoxBuildrootPlatforms]

export const rpiOSPlatforms: Option[] = [
  { value: '', label: 'Autodetect' },
  { value: 'pi.zerow', label: 'Raspberry Pi Zero W' },
  { value: 'pi.zerow2', label: 'Raspberry Pi Zero W2' },
  { value: 'pi.5', label: 'Raspberry Pi 5' },
  { value: 'pi.4', label: 'Raspberry Pi 4' },
  { value: 'pi', label: 'Raspberry Pi generic' },
  { value: 'debian', label: 'Debian generic' },
  { value: 'ubuntu', label: 'Ubuntu generic' },
]

export const modes: Option[] = [
  { value: 'rpios', label: 'Raspberry Pi OS (default)' },
  { value: 'nixos', label: 'NixOS (new, experimental)' },
  { value: 'buildroot', label: 'Buildroot (very early alpha)' },
]
