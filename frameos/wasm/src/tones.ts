// A scene's frameos.tone() in the browser (docs/tones.md): the notes the
// runtime kept ("hz:ms,..." with 0 Hz a rest, tones.nim normalizeTones),
// played with Web Audio at the frame's own pitches, so an author hears the
// reminder the buzzer would sound. A soft triangle wave, not the piezo's
// square: the same tune, kinder to a laptop's speakers. A tone while one
// sounds replaces it, as on the frame. Quietly nothing where the page may
// not play sound yet (no click on it so far: the browser's autoplay rule).

const VOLUME = 0.06
const EDGE_S = 0.004 // fade in and out, so the notes do not click

let context: AudioContext | null = null
let sounding: OscillatorNode[] = []

/** The notes as numbers, [hz, ms] each; what is not a pair is left out. */
export function parseTones(notes: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const pair of String(notes || '').split(',')) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(pair)
    if (match) {
      out.push([Number(match[1]), Number(match[2])])
    }
  }
  return out
}

function audioContext(): AudioContext | null {
  if (context) {
    return context
  }
  const Context =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) {
    return null
  }
  try {
    context = new Context()
  } catch {
    context = null
  }
  return context
}

/** Play a scene's notes; a call while some sound stops them first. */
export function playTones(notes: string): void {
  const tune = parseTones(notes)
  if (tune.length === 0) {
    return
  }
  const audio = audioContext()
  if (!audio) {
    return
  }
  if (audio.state === 'suspended') {
    void audio.resume().catch(() => undefined)
  }
  for (const oscillator of sounding) {
    try {
      oscillator.stop()
    } catch {
      // already over
    }
  }
  sounding = []
  let at = audio.currentTime + 0.02
  for (const [hz, ms] of tune) {
    const seconds = ms / 1000
    if (hz > 0) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'triangle'
      oscillator.frequency.value = hz
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(VOLUME, at + Math.min(EDGE_S, seconds / 4))
      gain.gain.setValueAtTime(VOLUME, at + Math.max(seconds - EDGE_S, seconds / 2))
      gain.gain.linearRampToValueAtTime(0, at + seconds)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(at)
      oscillator.stop(at + seconds + 0.01)
      sounding.push(oscillator)
    }
    at += seconds
  }
}
