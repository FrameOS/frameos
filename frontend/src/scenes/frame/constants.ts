import { Option } from '../../components/Select'

// Color WaveShare frames commented out, since we don't support them yet

export const devices: Option[] = [
  { value: 'web_only', label: 'Web only' },
  { value: 'framebuffer', label: 'HDMI / Framebuffer' },
  { value: 'pimoroni.inky_impression', label: 'Pimoroni Inky Impression e-ink frames' },
  { value: 'pimoroni.hyperpixel2r', label: 'Pimoroni HyperPixel 2.1" Round' },
  { value: 'waveshare.epd2in13_V3', label: 'Waveshare 2.13" 250×122 V3 Touch' },
  { value: 'waveshare.epd7in5_V2', label: 'Waveshare 7.5" 800×480 V2' },
  { value: '-', label: '----- Unverified frames below -----' },
  { value: 'waveshare.epd1in02', label: 'Waveshare 1.02" 128×80' },
  { value: 'waveshare.epd1in54', label: 'Waveshare 1.54" 200x200' },
  { value: 'waveshare.epd1in54_V2', label: 'Waveshare 1.54" 200x200 V2' },
  { value: 'waveshare.epd1in54b', label: 'Waveshare 1.54" 200x200 B' },
  { value: 'waveshare.epd1in54b_V2', label: 'Waveshare 1.54" 200x200 B_V2' },
  { value: 'waveshare.epd1in54c', label: 'Waveshare 1.54" 152x152 C' },
  { value: 'waveshare.epd1in64g', label: 'Waveshare 1.64" 168x168 G' },
  // { value: 'waveshare.epd2in13b_V3', label: 'Waveshare 2.13" 212x104 B_V3' },
  // { value: 'waveshare.epd2in13bc', label: 'Waveshare 2.13" 212x104 BC' },
  { value: 'waveshare.epd2in13d', label: 'Waveshare 2.13" 212x104 D' },
  { value: 'waveshare.epd2in13', label: 'Waveshare 2.13" 250×122' },
  { value: 'waveshare.epd2in13g', label: 'Waveshare 2.13" 250x122 G' },
  { value: 'waveshare.epd2in13_V2', label: 'Waveshare 2.13" 250×122 V2' },
  { value: 'waveshare.epd2in13_V4', label: 'Waveshare 2.13" 250×122 V4' },
  // { value: 'waveshare.epd2in13b_V4', label: 'Waveshare 2.13" 250x122 B_V4' },
  { value: 'waveshare.epd2in36g', label: 'Waveshare 2.36" 296x168 G' },
  { value: 'waveshare.epd2in66', label: 'Waveshare 2.66" 296x152' },
  { value: 'waveshare.epd2in66b', label: 'Waveshare 2.66" 296x152 B' },
  { value: 'waveshare.epd2in7', label: 'Waveshare 2.7" 264x176' },
  { value: 'waveshare.epd2in7_V2', label: 'Waveshare 2.7" 264x176 V2' },
  // { value: 'waveshare.epd2in7b', label: 'Waveshare 2.7" 264x176 B' },
  // { value: 'waveshare.epd2in7b_V2', label: 'Waveshare 2.7" 264x176 B_V2' },
  { value: 'waveshare.epd2in9', label: 'Waveshare 2.9" 296x128' },
  { value: 'waveshare.epd2in9_V2', label: 'Waveshare 2.9" 296x128 V2' },
  { value: 'waveshare.epd2in9b_V3', label: 'Waveshare 2.9" 296x128 B_V3' },
  { value: 'waveshare.epd2in9bc', label: 'Waveshare 2.9" 296x128 BC' },
  { value: 'waveshare.epd2in9d', label: 'Waveshare 2.9" 296x128 D' },
  { value: 'waveshare.epd3in0g', label: 'Waveshare 3.0" 400x168 G' },
  { value: 'waveshare.epd3in52', label: 'Waveshare 3.52" 360x240' },
  { value: 'waveshare.epd3in7', label: 'Waveshare 3.7" 480x280' },
  { value: 'waveshare.epd4in01f', label: 'Waveshare 4.01" 640x400 F' },
  { value: 'waveshare.epd4in2', label: 'Waveshare 4.2" 400x300' },
  // { value: 'waveshare.epd4in2b_V2', label: 'Waveshare 4.2" 400x300 B_V2' },
  // { value: 'waveshare.epd4in2bc', label: 'Waveshare 4.2" 400x300 BC' },
  { value: 'waveshare.epd4in37g', label: 'Waveshare 4.37" 512x368 G' },
  { value: 'waveshare.epd5in83', label: 'Waveshare 5.83" 600x448' },
  // { value: 'waveshare.epd5in83bc', label: 'Waveshare 5.83" 600x448 BC' },
  { value: 'waveshare.epd5in65f', label: 'Waveshare 5.65" 600x448 F' },
  { value: 'waveshare.epd5in83_V2', label: 'Waveshare 5.83" 648x480 V2' },
  // { value: 'waveshare.epd5in83b_V2', label: 'Waveshare 5.83" 648x480 B_V2' },
  { value: 'waveshare.epd7in3f', label: 'Waveshare 7.3" 800x480 F' },
  { value: 'waveshare.epd7in3g', label: 'Waveshare 7.3" 800x480 G' },
  { value: 'waveshare.epd7in5', label: 'Waveshare 7.5" 640x384' },
  // { value: 'waveshare.epd7in5bc', label: 'Waveshare 7.5" 640x384 BC' },
  { value: 'waveshare.epd7in5_V2_fast', label: 'Waveshare 7.5" 800×480 V2_fast' },
  { value: 'waveshare.epd7in5b_V2', label: 'Waveshare 7.5" 800×480 B_V2 3-COLOR' },
  { value: 'waveshare.epd7in5_HD', label: 'Waveshare 7.5" 880x528 HD' },
  // { value: 'waveshare.epd7in5b_HD', label: 'Waveshare 7.5" 880x528 B_HD' },
]
