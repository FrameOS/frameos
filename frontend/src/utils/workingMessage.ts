import messg, { error, success, warning } from 'messg'
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

// Long messages need time to be read (~50ms per character); a click still dismisses instantly.
function readableDuration(text: string, minimum: number): number {
  return Math.min(Math.max(minimum, text.length * 50), 20000)
}

export function showWorkingMessage(text: string): {
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
} {
  configureMessg()

  const message = messg(
    `<div class="frameos-working-message"><span class="frameos-working-message__spinner"></span><span>${text}</span></div>`
  )

  return {
    success: (successMessage: string) => {
      message?.hide()
      success(successMessage, readableDuration(successMessage, 3500))
    },
    warning: (warningMessage: string) => {
      message?.hide()
      warning(warningMessage, readableDuration(warningMessage, 4500))
    },
    error: (errorMessage: string) => {
      message?.hide()
      error(errorMessage, readableDuration(errorMessage, 4500))
    },
  }
}

export function showSuccessMessage(text: string): void {
  configureMessg()
  success(text, readableDuration(text, 3500))
}

export function showErrorMessage(text: string): void {
  configureMessg()
  error(text, readableDuration(text, 4500))
}
