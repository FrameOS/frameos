import timezones from './timezones.json'

export const timezoneOptions = timezones.map((tz) => ({
  value: tz,
  label: tz,
}))
