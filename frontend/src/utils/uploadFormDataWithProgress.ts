import { getBasePath } from './getBasePath'

interface UploadFormDataWithProgressOptions {
  url: string
  formData: FormData
  onProgress?: (uploadedBytes: number, totalBytes: number | null) => void
}

export function uploadFormDataWithProgress<T = any>({
  url,
  formData,
  onProgress,
}: UploadFormDataWithProgressOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const requestUrl = getBasePath() && url.startsWith('/') ? `${getBasePath()}${url}` : url

    xhr.open('POST', requestUrl)
    xhr.withCredentials = true

    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : null)
    }

    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed with status ${xhr.status}`))
        return
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T)
      } catch (error) {
        reject(error)
      }
    }

    xhr.send(formData)
  })
}
