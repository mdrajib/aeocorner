import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

/**
 * The Content Studio's rich-text editor (MVP F8, task 7.08). TipTap on ProseMirror, bundled into one file served from
 * our own origin (`/vendor/editor.js`, built by `npm run build:editor`), so the strict CSP stays as it is (ADR-0003,
 * ADR-0011): no CDN, no inline script, and TipTap's own stylesheet injection is switched off (`injectCSS: false`)
 * because a dynamically added <style> element would break `style-src 'self'`; the editor's look is in
 * `tailwind/components.css`.
 *
 * The page works without it: the draft is a plain <textarea> of HTML, and this script only upgrades it. The textarea
 * stays the source of truth for the form, so what is saved is whatever the textarea holds when the form is sent; the
 * server sanitizes it again (src/core/content-html.js), never trusting the editor.
 *
 * Only what the sanitizer keeps is allowed: h2 to h4, paragraphs, lists, tables, quotes, links, bold and italic.
 */

const TOOLS = [
  {
    id: 'p',
    label: 'Body text',
    text: 'P',
    run: (e) => e.chain().focus().setParagraph().run(),
    active: (e) => e.isActive('paragraph'),
  },
  {
    id: 'h2',
    label: 'Heading',
    text: 'H2',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    active: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Sub-heading',
    text: 'H3',
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    active: (e) => e.isActive('heading', { level: 3 }),
  },
  {
    id: 'bold',
    label: 'Bold',
    text: 'B',
    run: (e) => e.chain().focus().toggleBold().run(),
    active: (e) => e.isActive('bold'),
  },
  {
    id: 'italic',
    label: 'Italic',
    text: 'I',
    run: (e) => e.chain().focus().toggleItalic().run(),
    active: (e) => e.isActive('italic'),
  },
  {
    id: 'ul',
    label: 'Bulleted list',
    text: '• List',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    active: (e) => e.isActive('bulletList'),
  },
  {
    id: 'ol',
    label: 'Numbered list',
    text: '1. List',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    active: (e) => e.isActive('orderedList'),
  },
  {
    id: 'quote',
    label: 'Quote',
    text: '“ ”',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    active: (e) => e.isActive('blockquote'),
  },
  {
    id: 'link',
    label: 'Link',
    text: 'Link',
    run: (e) => {
      const previous = e.getAttributes('link').href ?? '';
      const href = window.prompt('Web address (leave empty to remove the link)', previous);
      if (href === null) return;
      if (href.trim() === '') e.chain().focus().extendMarkRange('link').unsetLink().run();
      else e.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
    },
    active: (e) => e.isActive('link'),
  },
  {
    id: 'undo',
    label: 'Undo',
    text: 'Undo',
    run: (e) => e.chain().focus().undo().run(),
    active: () => false,
  },
  {
    id: 'redo',
    label: 'Redo',
    text: 'Redo',
    run: (e) => e.chain().focus().redo().run(),
    active: () => false,
  },
];

function mount(root) {
  const source = root.querySelector('textarea[data-editor-source]');
  if (!source || root.dataset.editorReady) return null;
  root.dataset.editorReady = 'true';

  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Formatting');
  const surface = document.createElement('div');
  surface.className = 'editor-surface';
  source.insertAdjacentElement('beforebegin', toolbar);
  source.insertAdjacentElement('beforebegin', surface);

  const editor = new Editor({
    element: surface,
    injectCSS: false,
    content: source.value,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: { openOnClick: false, autolink: false, HTMLAttributes: { rel: null, target: null } },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    editorProps: {
      attributes: {
        class: 'editor-content',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': root.dataset.editorLabel || 'Page text',
      },
    },
    onUpdate: ({ editor: e }) => {
      source.value = e.getHTML();
      source.dispatchEvent(new Event('input', { bubbles: true }));
    },
  });

  const buttons = TOOLS.map((tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-tool';
    button.textContent = tool.text;
    button.setAttribute('aria-label', tool.label);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => tool.run(editor));
    toolbar.append(button);
    return { tool, button };
  });
  const refresh = () => {
    for (const { tool, button } of buttons) {
      button.setAttribute('aria-pressed', String(Boolean(tool.active(editor))));
    }
  };
  editor.on('transaction', refresh);
  refresh();

  source.hidden = true;
  root.classList.add('editor-ready');
  return editor;
}

const start = () => document.querySelectorAll('[data-editor]').forEach(mount);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

window.AEOEditor = { mount };
