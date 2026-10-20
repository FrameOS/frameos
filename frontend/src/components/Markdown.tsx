import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import clsx from 'clsx'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { router } from 'kea-router'
import type { MouseEvent } from 'react'

export interface MarkdownProps {
  /** Scene-supplied (store zips, imported JSON, AI output): not guaranteed a string. */
  value: unknown
  /** Links that stay in the app (the AI chat's frameos:// links,
   * utils/chatLinks.ts): the route an href stands for, or null when it is an
   * ordinary link. They open in this tab; every other link in a new one. */
  inAppRoute?: (href: string) => string | null
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

// A plain click navigates in place; a modified one (new tab, new window) is
// the browser's.
function followInAppLink(event: MouseEvent<HTMLAnchorElement>, route: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return
  }
  event.preventDefault()
  router.actions.push(route)
}

export function Markdown({ value: rawValue, inAppRoute }: MarkdownProps) {
  const value = markdownSource(rawValue)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className="space-y-4"
      // An in-app link keeps its own scheme until the `a` below resolves it;
      // everything else goes through the default filter (no javascript:).
      urlTransform={(url, key) => (key === 'href' && inAppRoute?.(url) ? url : defaultUrlTransform(url))}
      components={{
        // The markdown is app- and scene-supplied: new tabs get no opener and
        // no referrer (the referrer would carry the frame's editor URL).
        a({ node, href, ...props }) {
          const route = href && inAppRoute ? inAppRoute(href) : null
          if (route) {
            return (
              <a
                {...props}
                href={route}
                onClick={(event) => followInAppLink(event, route)}
                className="text-blue-400 hover:underline"
              />
            )
          }
          // A link the filter emptied (an unsafe or unknown scheme) is its text.
          if (!href) {
            return <span>{props.children}</span>
          }
          return (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            />
          )
        },
        // An <img> would load the moment an app node renders, so any app could
        // fetch a tracking pixel from any host. Images render as a link to
        // open by choice instead.
        img({ node, src, alt }) {
          const label = alt ? `Image: ${alt}` : 'Image'
          return src ? (
            <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
              {label}
            </a>
          ) : (
            <span>{label}</span>
          )
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
