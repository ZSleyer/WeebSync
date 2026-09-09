import { Fragment, type ReactNode } from 'react'

// The markdown an answer may carry: headings, bullet and numbered lists,
// fenced code, paragraphs; bold, italics, code spans and links inside. No
// HTML ever, the text is rendered as React nodes. Titles the answer names
// become buttons into the catalog (see linkTitles).

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'para'; text: string }

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'para', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i])
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', level: h[1].length, text: h[2].trim() })
      continue
    }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = /^\s*\d/.test(line)
      const items = [li[1]]
      while (i + 1 < lines.length) {
        const next = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(lines[i + 1])
        if (!next) break
        items.push(next[1])
        i++
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

export interface TitleLink {
  title: string
  onClick: () => void
}

// inline: **bold**, *italic*, `code`, [text](https://…); then the titles
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g

function inline(text: string, titles: TitleLink[], key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) nodes.push(...linkTitles(text.slice(last, m.index), titles, `${key}-${n++}`))
    const tok = m[0]
    if (tok.startsWith('**')) nodes.push(<strong key={`${key}-${n++}`}>{linkTitles(tok.slice(2, -2), titles, `${key}-b${n}`)}</strong>)
    else if (tok.startsWith('`')) nodes.push(<code key={`${key}-${n++}`} className="font-mono text-[0.9em]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('[')) {
      const close = tok.indexOf('](')
      nodes.push(
        <a key={`${key}-${n++}`} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
          {tok.slice(1, close)}
        </a>,
      )
    } else nodes.push(<em key={`${key}-${n++}`}>{linkTitles(tok.slice(1, -1), titles, `${key}-i${n}`)}</em>)
    last = m.index! + tok.length
  }
  if (last < text.length) nodes.push(...linkTitles(text.slice(last), titles, `${key}-${n++}`))
  return nodes
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// linkTitles turns every occurrence of a known title into a button, the
// longest titles first so a season name wins over the show's bare name.
export function linkTitles(text: string, titles: TitleLink[], key: string): ReactNode[] {
  if (titles.length === 0 || !text) return [text]
  const sorted = [...titles].filter((t) => t.title.length >= 3).sort((a, b) => b.title.length - a.title.length)
  if (sorted.length === 0) return [text]
  const re = new RegExp(sorted.map((t) => escapeRe(t.title)).join('|'), 'gi')
  const nodes: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) nodes.push(text.slice(last, m.index))
    const hit = sorted.find((t) => t.title.toLowerCase() === m[0].toLowerCase())
    nodes.push(
      <button key={`${key}-t${n++}`} type="button" className="text-accent underline underline-offset-2 hover:text-t-primary" onClick={hit?.onClick}>
        {m[0]}
      </button>,
    )
    last = m.index! + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export default function Markdown({ text, titles = [], children }: { text: string; titles?: TitleLink[]; children?: ReactNode }) {
  const blocks = parseMarkdown(text)
  return (
    <div className="space-y-2 wrap-break-word">
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.kind) {
          case 'heading':
            return (
              <p key={key} className={b.level <= 2 ? 'font-display font-semibold tracking-wider' : 'font-semibold'}>
                {inline(b.text, titles, key)}
              </p>
            )
          case 'list':
            return b.ordered ? (
              <ol key={key} className="list-decimal space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, titles, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, titles, `${key}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'code':
            return (
              <pre key={key} className="overflow-x-auto border border-border-subtle bg-bg-card p-2 font-mono text-sm">
                {b.text}
              </pre>
            )
          default:
            return (
              <p key={key} className="whitespace-pre-wrap">
                {inline(b.text, titles, key)}
                {i === blocks.length - 1 && children}
              </p>
            )
        }
      })}
      {blocks.length === 0 && children && <p>{children}</p>}
      {blocks.length > 0 && blocks[blocks.length - 1].kind !== 'para' && children && <Fragment>{children}</Fragment>}
    </div>
  )
}
