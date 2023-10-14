export function downloadJson(jsonObject: object, fileName: string): void {
  const jsonString: string = JSON.stringify(jsonObject, null, 2)
  const blob: Blob = new Blob([jsonString], { type: 'application/json' })
  const link: HTMLAnchorElement = document.createElement('a')
  link.download = fileName
  link.href = URL.createObjectURL(blob)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
