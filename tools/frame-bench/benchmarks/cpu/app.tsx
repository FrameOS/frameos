// Frame bench: CPU (workload 1). Four fixed pieces of JavaScript, each timed
// by the board's own clock and logged as one line:
//   {"bench":"cpu","w":1,"int":…,"float":…,"json":…,"str":…,"check":…}
// The picture is the same every render, so an e-paper panel does not refresh
// after the first. Changing a loop count changes every score: bump `w` and
// the scene id's suffix (tools/frame-bench/SCORES.md, "Workload versions").

const W = 1

function intWork() {
  const N = 40000
  const sieve = new Uint8Array(N + 1)
  let primes = 0
  for (let i = 2; i <= N; i++) {
    if (!sieve[i]) {
      primes++
      for (let j = i * i; j <= N; j += i) sieve[j] = 1
    }
  }
  let x = 2463534242
  for (let i = 0; i < 100000; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
  }
  return primes ^ (x & 0xffff)
}

function floatWork() {
  let total = 0
  const w = 96, h = 64, maxIt = 48
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x0 = (px / w) * 3.5 - 2.5, y0 = (py / h) * 2 - 1
      let x = 0, y = 0, i = 0
      while (x * x + y * y < 4 && i < maxIt) {
        const t = x * x - y * y + x0
        y = 2 * x * y + y0
        x = t
        i++
      }
      total += i
    }
  }
  return total
}

function jsonWork() {
  const rows = []
  for (let i = 0; i < 200; i++) rows.push({ id: i, name: 'item ' + i, tags: ['a', 'b', String(i % 7)], v: i * 1.5 })
  let n = 0
  for (let k = 0; k < 10; k++) {
    const s = JSON.stringify(rows)
    n += JSON.parse(s).length + s.length
  }
  return n
}

function strWork() {
  let s = ''
  for (let i = 0; i < 2000; i++) s += String.fromCharCode(97 + (i % 26))
  let n = 0
  for (let k = 0; k < 60; k++) {
    n += s.split('e').length
    n += s.replace(/[aeiou]/g, '').length
    n += s.toUpperCase().indexOf('Z')
  }
  return n
}

function timed(fn) {
  const t = Date.now()
  const r = fn()
  return [Date.now() - t, r]
}

export function get(app) {
  const [tInt, a] = timed(intWork)
  const [tFloat, b] = timed(floatWork)
  const [tJson, c] = timed(jsonWork)
  const [tStr, d] = timed(strWork)
  frameos.log({ bench: 'cpu', w: W, int: tInt, float: tFloat, json: tJson, str: tStr, check: (a + b + c + d) % 100000 })
  return (
    <svg viewBox="0 0 400 240" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="400" height="240" fill="#ffffff" />
      <rect x="40" y="40" width="120" height="160" fill="#000000" />
      <circle cx="280" cy="120" r="70" fill="#000000" />
    </svg>
  )
}
