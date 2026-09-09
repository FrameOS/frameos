import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'

export interface MarkdownProps {
  /** Scene-supplied (store zips, imported JSON, AI output): not guaranteed a string. */
  value: unknown
}

/** react-markdown 9 throws on non-string children, which took the whole
 * diagram down on one `"markdown": {"x": 1}` in an app config. Coerce. */
function markdownSource(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return '```json\n' + JSON.stringify(value, null, 2) + '\n```'
  } catch {
    return String(value)
  }
}

export function Markdown({ value: rawValue }: MarkdownProps) {
  const value = markdownSource(rawValue)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="space-y-4"
      components={{
        a({ node, ...props }) {
          return <a target="_blank" {...props} className="text-blue-400 hover:underline" />
        },
        p({ node, ...props }) {
          return <p {...props} />
        },
        code(props) {
          const { children, className, node, ref, ...rest } = props
          const match = /language-(\w+)/.exec(className || '')
          return match ? (
            <SyntaxHighlighter
              {...rest}
              children={String(children).replace(/\n$/, '')}
              style={vscDarkPlus}
              language={match[1]}
              PreTag="div"
            />
          ) : (
            <code {...rest} className={clsx('frameos-inset rounded px-1 py-0.5', className)}>
              {children}
            </code>
          )
        },
      }}
    >
      {value}
    </ReactMarkdown>
  )
}
