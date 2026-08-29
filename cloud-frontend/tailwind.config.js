/** @type {import('tailwindcss').Config} */
export default {
  // Follow the app's own theme toggle, not the OS `prefers-color-scheme`
  // (Tailwind's default): a dark macOS with the workspace set to light was
  // getting `dark:` colours painted onto light backgrounds. Same selectors as
  // the theme rules in frontend/src/index.css.
  darkMode: ['variant', ["&:where(html[data-frameos-theme='dark'] *)", '&:where(.frameos-theme-dark *)']],
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    './src/index.html',
    '../frontend/src/**/*.{js,ts,jsx,tsx}',
    '../frontend/src/index.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [require('@tailwindcss/container-queries')],
}
