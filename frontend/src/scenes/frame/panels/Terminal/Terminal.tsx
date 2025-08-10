import { useValues } from 'kea'
import { frameLogic } from '../../frameLogic'
import { getBasePath } from '../../../../utils/getBasePath'
import { useEffect, useRef, useState, KeyboardEvent } from 'react'

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

export function Terminal() {
  const { frame } = useValues(frameLogic)
  const [output, setOutput] = useState('')
  const [cmd, setCmd] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const outputRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    setOutput(
      (prev) => prev + (prev !== '' ? '\n' : '') + `***connecting to ${frame.ssh_user}@${frame.frame_host}***\n`
    )
    const ws = new WebSocket(`${getBasePath()}/ws/terminal/${frame.id}` + (token ? `?token=${token}` : ''))
    wsRef.current = ws
    ws.onmessage = (event) => {
      setOutput((prev) => prev + stripAnsi(event.data))
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight
      }
    }
    ws.onclose = () => setOutput((prev) => prev + '\n*** connection closed ***\n')
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [frame.id])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      wsRef.current?.send(cmd + '\n')
      setCmd('')
    }
  }

  return (
    <div className="flex flex-col h-full space-y-2">
      <pre ref={outputRef} className="flex-1 overflow-y-auto border p-2 rounded bg-black text-white">
        {output}
      </pre>
      <div>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          className="w-full border p-1 rounded bg-black text-white"
          placeholder="enter command"
        />
      </div>
    </div>
  )
}
