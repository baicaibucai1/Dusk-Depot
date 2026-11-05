/*
 * v3 的**单块**文本编辑器。
 *
 * 每个块一个 TipTap 实例 —— 这是"纵向块画布"和 v2 文档流最根本的区别：
 * 块是独立的卡片，不是一整篇 ProseMirror 文档的顶层节点。
 *
 * 这一层只做三件事：
 *   ① 把 BoardBlock.content（Inline[]）装进一个最小的 ProseMirror 文档；
 *   ② 用户改动时再抽回 Inline[]，交给外层记账；
 *   ③ 回车 = 新建下一块（在末尾）/ 软换行（在中间）；空块退格 = 删块。
 */
import type { Editor } from '@tiptap/core'
import { Link } from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { type Inline, inlineNodes, inlineOf } from '../../core/note/flow'
import type { PmDoc, PmNode } from '../../core/note/pm'
import { BubbleBar } from './BubbleBar'

/**
 * 只要求"长得像一块可编辑文本"。
 * 不写死成 `.note` 的 BoardBlock —— `.board` 那边的块类型更宽（多了 group 等），
 * 绑死会让两个模块的类型互相打架。
 */
export type TextBlock = {
  id: string
  type: string
  content?: Inline[]
  checked?: boolean
}

type Props = {
  block: TextBlock
  autoFocus?: boolean
  onChange: (content: Inline[]) => void
  onEnterEnd: () => void
  onBackspaceEmpty: () => void
  onEditor: (id: string, editor: Editor | null) => void
}

function initialDoc(block: TextBlock): PmDoc {
  const inline = inlineNodes(block.content ?? [])
  if (block.type === 'heading1' || block.type === 'heading2') {
    return {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: block.type === 'heading1' ? 1 : 2 }, content: inline }],
    }
  }
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] }
}

/** PM 文档 → Inline[]。多段落压成软换行，保证一块只有一段内容。 */
function contentOfPm(json: PmDoc): Inline[] {
  const out: Inline[] = []
  const nodes = json.content ?? []
  nodes.forEach((node: PmNode, i) => {
    if (i > 0) out.push({ type: 'hardBreak' })
    out.push(...inlineOf(node.content ?? []))
  })
  return out
}

export function BoardTextEditor({ block, autoFocus, onChange, onEnterEnd, onBackspaceEmpty, onEditor }: Props) {
  const changeRef = useRef(onChange)
  const enterRef = useRef(onEnterEnd)
  const backspaceRef = useRef(onBackspaceEmpty)
  changeRef.current = onChange
  enterRef.current = onEnterEnd
  backspaceRef.current = onBackspaceEmpty

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2] },
          blockquote: false,
          codeBlock: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
          link: false,
          underline: false,
          // ⚠️ 每块只有一个顶层节点；TrailingNode 会在标题/引用后面塞一个空段落，
          //    看起来就是"标题下面多了一行占位"，必须关掉
          trailingNode: false,
        }),
        Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
        Placeholder.configure({
          placeholder:
            block.type === 'heading1'
              ? '一级标题'
              : block.type === 'heading2'
                ? '二级标题'
                : block.type === 'quote'
                  ? '引用一句话'
                  : block.type === 'todo'
                    ? '待办事项'
                    : '输入文字，回车换块；Shift+回车软换行',
        }),
      ],
      content: initialDoc(block) as never,
      editable: true,
      editorProps: {
        attributes: { class: 'dd-board-input' },
        handleKeyDown: (view, event) => {
          if (event.isComposing) return false
          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault()
            const { state } = view
            const atEnd = state.selection.empty && state.selection.$to.pos >= state.doc.content.size - 1
            if (atEnd) {
              enterRef.current()
              return true
            }
            // 中间回车：只做软换行，不把一块拆成两段（块模型里一块只有一份 content）
            const node = state.schema.nodes.hardBreak
            if (node) view.dispatch(state.tr.replaceSelectionWith(node.create()))
            return true
          }
          if (event.key === 'Backspace' && view.state.selection.empty && view.state.selection.from <= 1) {
            if (view.state.doc.textContent.length === 0) {
              event.preventDefault()
              backspaceRef.current()
              return true
            }
          }
          return false
        },
      },
      onUpdate: ({ editor: ed }) => {
        changeRef.current(contentOfPm(ed.getJSON() as unknown as PmDoc))
      },
    },
    [block.id, block.type],
  )

  useEffect(() => {
    if (!editor) return
    onEditor(block.id, editor)
    return () => onEditor(block.id, null)
  }, [editor, block.id, onEditor])

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus('end')
  }, [editor, autoFocus])

  if (!editor) return <div className="min-h-[1.6em] text-[12px] text-ink-3">正在载入…</div>

  return (
    <>
      <EditorContent editor={editor} className="dd-board-input-wrap" />
      <BubbleBar editor={editor} />
    </>
  )
}
