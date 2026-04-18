export function get(app) {
  const label = app.config.label || 'QuickJS'
  const bg = app.config.background || '#ffffff'
  const fg = app.config.foreground || '#111111'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">
    <rect width="320" height="120" rx="18" fill="${bg}" />
    <circle cx="60" cy="60" r="28" fill="${fg}" opacity="0.15" />
    <text x="100" y="70" fill="${fg}" font-size="28" font-family="sans-serif">${label}</text>
  </svg>`
}
