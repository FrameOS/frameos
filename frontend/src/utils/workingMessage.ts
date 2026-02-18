import messg, { error, success } from 'messg'
import 'messg/index.css'

const messgInstance = messg as typeof messg & { position: string; max: number | null }
let configured = false

function configureMessg(): void {
  if (configured) {
    return
  }

  messgInstance.position = 'bottom-right'
  messgInstance.max = 5
  configured = true
}

export function showWorkingMessage(text: string): { success: (message: string) => void; error: (message: string) => void } {
  configureMessg()

  const message = messg(
    `<div class="frameos-working-message"><span class="frameos-working-message__spinner"></span><span>${text}</span></div>`
  )

  return {
    success: (successMessage: string) => {
      message?.hide()
      success(successMessage, 3500)
    },
    error: (errorMessage: string) => {
      message?.hide()
      error(errorMessage, 4500)
    },
  }
}
