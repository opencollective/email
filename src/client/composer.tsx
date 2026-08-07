/** @jsxImportSource react */

/** React island: the internal-note composer.
 *
 *  This is the one place in the app with real editing behaviour, so it is the
 *  one place that earns a client bundle. Everything else stays server-rendered
 *  HTML forms.
 *
 *  Two properties keep it safe to bolt onto a server-rendered page:
 *
 *  1. The server contract does not change. The editor serialises back to the
 *     same plain text a person would have typed ("@Marie Dupont"), writes it
 *     into the original <textarea>, and the form posts exactly as before.
 *     src/mentions.ts stays the single source of truth for who got mentioned —
 *     if this file and the server ever disagreed, the server wins and the
 *     notification is still correct. This code is only ever cosmetic.
 *  2. It is progressive enhancement. Without JS (or if this bundle fails to
 *     load) the plain textarea is still there and still works.
 *
 *  Why an editor at all: a <textarea> cannot style a range of its own text and
 *  exposes no caret geometry, so highlighted mention tokens and a dropdown
 *  anchored to the caret are both impossible in one. ProseMirror gives real DOM
 *  ranges and atomic nodes, which is exactly those two things. */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Placeholder } from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'

interface Person { id: number; name: string; email: string }
/** [label, memberId], longest label first — computed server-side by
 *  mentionLabels() so the *rules* (unique first names, login names) live in one
 *  place; the client only does the mechanical matching. */
type Label = [string, number]
interface Roster { people: Person[]; labels: Label[] }

/** Letters and digits — where a mention stops. Mirrors WORD in src/mentions.ts. */
const WORD = /[\p{L}\p{N}]/u

// ---------- the suggestion dropdown ----------

interface ListProps { items: Person[]; command: (p: Person) => void }
interface ListHandle { onKeyDown: (p: { event: KeyboardEvent }) => boolean }

const MentionList = forwardRef<ListHandle, ListProps>(({ items, command }, ref) => {
  const [sel, setSel] = useState(0)
  useEffect(() => { setSel(0) }, [items])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false
      if (event.key === 'ArrowUp') { setSel((s) => (s + items.length - 1) % items.length); return true }
      if (event.key === 'ArrowDown') { setSel((s) => (s + 1) % items.length); return true }
      if (event.key === 'Enter' || event.key === 'Tab') { command(items[sel]); return true }
      return false
    },
  }), [items, sel, command])

  return (
    <div className="mention-pop" role="listbox" aria-label="Members you can mention">
      {items.map((p, i) => (
        <button
          key={p.id} type="button" role="option" aria-selected={i === sel}
          className={`mp-item${i === sel ? ' on' : ''}`}
          // mousedown, not click: the editor must not lose focus before the pick
          onMouseDown={(e) => { e.preventDefault(); command(p) }}
          onMouseEnter={() => setSel(i)}
        >
          <b>{p.name}</b>
          <small>{p.email}</small>
        </button>
      ))}
    </div>
  )
})

// ---------- plain text <-> document ----------

/** Rebuild a document from text, so a draft restored from localStorage comes
 *  back with its mentions as tokens rather than as bare "@Name" text. */
function docFromText(text: string, roster: Roster) {
  const byId = new Map(roster.people.map((p) => [p.id, p]))
  const paragraphs = text.split('\n').map((line) => {
    const content: Record<string, unknown>[] = []
    const lower = line.toLowerCase()
    let buf = ''
    const flush = () => { if (buf) { content.push({ type: 'text', text: buf }); buf = '' } }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '@' && !(i > 0 && WORD.test(line[i - 1]))) {
        const rest = lower.slice(i + 1)
        const hit = roster.labels.find(([l]) => rest.startsWith(l) && !WORD.test(rest[l.length] ?? ' '))
        const person = hit && byId.get(hit[1])
        if (hit && person) {
          flush()
          content.push({ type: 'mention', attrs: { id: String(person.id), label: person.name } })
          i += hit[0].length
          continue
        }
      }
      buf += line[i]
    }
    flush()
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
  })
  return { type: 'doc', content: paragraphs }
}

// ---------- the composer ----------

function Composer({ textarea, roster }: { textarea: HTMLTextAreaElement; roster: Roster }) {
  const empty = useRef(true)

  const editor = useEditor({
    extensions: [
      Document, Paragraph, Text,
      Placeholder.configure({ placeholder: textarea.placeholder }),
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        // what getText() emits — the exact string the server parser expects
        renderText: ({ node }) => `@${node.attrs.label}`,
        suggestion: {
          char: '@',
          // the node carries the display name as `label`, which is what
          // renderText turns back into "@Marie Dupont" for the server
          command: ({ editor, range, props }: any) => {
            // don't leave a double space when one already follows the caret
            const after = editor.view.state.selection.$to.nodeAfter
            const to = after?.text?.startsWith(' ') ? range.to + 1 : range.to
            editor.chain().focus().insertContentAt({ from: range.from, to }, [
              { type: 'mention', attrs: { id: String(props.id), label: props.name } },
              { type: 'text', text: ' ' },
            ]).run()
            // ProseMirror leaves the caret between the token and its space —
            // without this, the next character typed runs into the name
            window.getSelection()?.collapseToEnd()
          },
          items: ({ query }) => {
            const q = query.toLowerCase()
            if (!q) return roster.people.slice(0, 6)
            return roster.people.filter((p) => {
              const n = p.name.toLowerCase()
              return n.startsWith(q) || p.email.toLowerCase().startsWith(q) ||
                n.split(/\s+/).some((w) => w.startsWith(q))
            }).slice(0, 6)
          },
          render: () => {
            let renderer: ReactRenderer<ListHandle, ListProps> | null = null
            let el: HTMLElement | null = null
            let onViewport: (() => void) | null = null

            const place = (clientRect?: (() => DOMRect | null) | null) => {
              if (!el || !clientRect) return
              const virtual = { getBoundingClientRect: () => clientRect() ?? new DOMRect() }
              computePosition(virtual, el, {
                placement: 'bottom-start',
                strategy: 'fixed',
                // flip/shift keep it on screen when the mobile keyboard eats
                // the viewport, without ever detaching it from the caret
                middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
              }).then(({ x, y }) => { if (el) { el.style.left = `${x}px`; el.style.top = `${y}px` } })
            }
            const show = (visible: boolean) => { if (el) el.style.display = visible ? '' : 'none' }

            return {
              onStart: (props: any) => {
                renderer = new ReactRenderer(MentionList, { props, editor: props.editor })
                el = renderer.element as HTMLElement
                el.style.position = 'fixed'
                el.style.zIndex = '60'
                document.body.appendChild(el)
                show(props.items.length > 0)
                place(props.clientRect)
                onViewport = () => place(props.clientRect)
                visualViewport?.addEventListener('resize', onViewport)
                visualViewport?.addEventListener('scroll', onViewport)
              },
              onUpdate: (props: any) => {
                renderer?.updateProps(props)
                show(props.items.length > 0)
                place(props.clientRect)
              },
              onKeyDown: (props: any) => {
                if (props.event.key === 'Escape') { show(false); return true }
                return renderer?.ref?.onKeyDown(props) ?? false
              },
              onExit: () => {
                if (onViewport) {
                  visualViewport?.removeEventListener('resize', onViewport)
                  visualViewport?.removeEventListener('scroll', onViewport)
                }
                el?.remove()
                renderer?.destroy()
                renderer = null; el = null; onViewport = null
              },
            }
          },
        },
      }),
    ],
    content: docFromText(textarea.value, roster),
    editorProps: { attributes: { class: 'note-input', 'aria-label': 'Internal note' } },
    onUpdate: ({ editor }) => {
      empty.current = editor.isEmpty
      // hand the text back to the textarea the form actually posts, and let the
      // existing draft-saver and typing beacon see it as ordinary input
      textarea.value = editor.getText({ blockSeparator: '\n' })
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    },
  })

  // The textarea can no longer carry `required` (a hidden required field is not
  // focusable and blocks submit), so hold the empty case here instead.
  useEffect(() => {
    const form = textarea.form
    if (!form || !editor) return
    const guard = (e: Event) => {
      if (!empty.current) return
      e.preventDefault()
      e.stopPropagation() // also stops the global "mark as sent" handler
      editor.commands.focus()
    }
    form.addEventListener('submit', guard, true)
    return () => form.removeEventListener('submit', guard, true)
  }, [editor, textarea])

  return <EditorContent editor={editor} />
}

// ---------- mount ----------

const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-mentions]')
if (textarea?.dataset.mentions) {
  try {
    const roster = JSON.parse(textarea.dataset.mentions) as Roster
    if (roster.people?.length) {
      textarea.style.display = 'none'
      textarea.removeAttribute('required')
      const host = document.createElement('div')
      host.className = 'note-editor'
      textarea.after(host)
      createRoot(host).render(<Composer textarea={textarea} roster={roster} />)
    }
  } catch {
    // leave the plain textarea in place — it still works
  }
}
