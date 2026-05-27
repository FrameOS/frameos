import { isValidElement, useMemo } from 'react'
import { Reveal } from './Reveal'
import { TextArea } from './TextArea'

export function SecretField(props: { children?: React.ReactNode; value?: string }) {
  const alwaysShow = useMemo(() => {
    return 'value' in props && (props.value === undefined || props.value === '' || props.value === null)
  }, []) // no deps
  const revealStyle = useMemo(() => {
    if (!isValidElement<{ rows?: number }>(props.children)) {
      return undefined
    }
    if (props.children.type !== TextArea && props.children.type !== 'textarea') {
      return undefined
    }
    const rows = props.children.props.rows ?? 8
    return { minHeight: `${rows * 1.45 + 0.9}rem` }
  }, []) // no deps

  if (alwaysShow) {
    return <div className="secret-field relative w-full">{props.children}</div>
  }

  return (
    <Reveal className="secret-field-reveal flex w-full items-center px-2.5 py-1.5" style={revealStyle}>
      {props.children}
    </Reveal>
  )
}
