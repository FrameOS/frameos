// Belgian waste collection days, from the recyclecms API behind RecycleApp.be.
const q = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

function api(path) {
  const { status, body, error } = frameos.httpRequest(`https://api.fostplus.be/recyclecms/public/v1/${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'x-consumer': 'recycleapp.be' },
  })
  if (!status) throw new Error(error)
  if (status >= 400) throw new Error(`HTTP ${status}: ${body}`)
  return JSON.parse(body)
}

function day(value, field) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) throw new Error(`Invalid ${field} "${value}": expected YYYY-MM-DD.`)
  const date = new Date(0)
  date.setUTCFullYear(m[1], m[2] - 1, m[3])
  return date.toISOString().slice(0, 10)
}

export function get(app) {
  const c = app.config
  const timezone = app.frame.timeZone || 'UTC'
  const today = (ms) =>
    new Date(timezone === 'UTC' ? ms : ms - new Date(ms).getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
  const from = c.exportFrom ? day(c.exportFrom, 'exportFrom') : today(Date.now())
  const until = c.exportUntil ? day(c.exportUntil, 'exportUntil') : today(Date.now() + 366 * 864e5)

  frameos.log('Preparing request headers...')
  frameos.log('Fetching collections...')
  frameos.log('Fetching address IDs...')
  const zip = api(`zipcodes?q=${c.postalCode}`).items?.find((item) => +item.code === c.postalCode)?.id
  if (!zip) throw new Error('Could not find the right zip code.')
  const street = api(`streets?q=${q(c.streetName)}&zipcodes=${q(zip)}`).items?.find(
    (item) => item.name === c.streetName
  )?.id
  if (!street) throw new Error('Could not find the right street name.')
  const { items } = api(
    `collections?zipcodeId=${q(zip)}&streetId=${q(street)}&houseNumber=${c.number}` +
      `&fromDate=${from}&untilDate=${until}&size=100`
  )
  if (!items) throw new Error('Something went wrong while fetching collections.')

  frameos.log({ event: 'reply', eventsInRange: items.length })
  frameos.log('Converting collections to events...')
  return items.map((item) => {
    const date = item.timestamp.split('T')[0]
    const summary = `Trash: ${item.fraction?.name?.[c.language] ?? ''}`
    return { summary, startTime: `${date}T08:00:00`, endTime: `${date}T08:15:00`, timezone }
  })
}
