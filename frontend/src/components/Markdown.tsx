import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'

export interface MarkdownProps {
  value: string
}

export function Markdown({ value }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="space-y-4"
      components={{
        a({ node, ...props }) {
          return <a target="_blank" {...props} className="text-blue-400 hover:underline" />
        },
        p({ node, ...props }) {
          return <p {...props} className="mb-4" />
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
            <code {...rest} className={clsx('bg-black', className)}>
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
