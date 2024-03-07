export function searchInText(search: string, text: string | null | undefined): boolean {
  if (typeof text !== 'string') {
    return false
  }
  return text.toLowerCase().includes(search.toLowerCase())
}
