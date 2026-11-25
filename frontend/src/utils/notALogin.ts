/**
 * Props for a field that holds a secret that is not a login to this site: a
 * Wi-Fi network's name and password. Without them a password manager takes the
 * pair for a sign-in or sign-up form and offers to fill or save a login.
 * `autocomplete="off"` alone stops none of them; each reads its own attribute
 * (1Password, LastPass, Bitwarden, Dashlane in that order).
 */
export const NOT_A_LOGIN = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const
