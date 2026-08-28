import { useEffect, useRef, useState } from 'react';
import {
  CodeIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  RedoIcon,
  TextBoldIcon,
  TextItalicIcon,
  UndoIcon
} from '@hugeicons/core-free-icons';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { Tooltip } from './ui/Tooltip';

const MAX_LENGTH = 2_000;

type FormatCommand = 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList' | 'formatBlock';

const FORMATS: Array<{
  command: FormatCommand;
  value?: string;
  label: string;
  icon: typeof TextBoldIcon;
}> = [
  { command: 'bold', label: 'Bold', icon: TextBoldIcon },
  { command: 'italic', label: 'Italic', icon: TextItalicIcon },
  { command: 'insertUnorderedList', label: 'Bullets', icon: LeftToRightListBulletIcon },
  { command: 'insertOrderedList', label: 'Numbers', icon: LeftToRightListNumberIcon },
  { command: 'formatBlock', value: 'pre', label: 'Code', icon: CodeIcon }
];

export function RichTextEditor({ value, disabled, onChange, onSubmit }: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const [active, setActive] = useState<Set<FormatCommand>>(new Set());

  useEffect(() => {
    const editor = editorRef.current;
    if (value === '' && editor?.innerHTML) {
      editor.innerHTML = '';
      setEmpty(true);
    }
  }, [value]);

  const emit = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    let text = normalizeText(editor.innerText);
    if (text.length > MAX_LENGTH) {
      text = text.slice(0, MAX_LENGTH);
      editor.innerText = text;
      placeCaretAtEnd(editor);
    }
    setEmpty(text.length === 0);
    onChange(text);
    refreshFormats();
  };

  const refreshFormats = (): void => {
    const next = new Set<FormatCommand>();
    for (const { command, value: commandValue } of FORMATS) {
      if (command === 'formatBlock') {
        if (document.queryCommandValue('formatBlock').toLowerCase() === commandValue) next.add(command);
      } else if (document.queryCommandState(command)) {
        next.add(command);
      }
    }
    setActive(next);
  };

  const format = (command: FormatCommand, commandValue?: string): void => {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(command, false, commandValue);
    emit();
  };

  const history = (command: 'undo' | 'redo'): void => {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(command);
    emit();
  };

  return (
    <div className={`rich-editor ${disabled ? 'disabled' : ''}`}>
      <div className="rich-toolbar" aria-label="Formatting">
        {FORMATS.map((option) => (
          <Tooltip key={option.label} content={option.label}>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={active.has(option.command) ? 'active' : ''}
              aria-label={option.label}
              aria-pressed={active.has(option.command)}
              disabled={disabled}
              onMouseDown={(event) => {
                event.preventDefault();
                format(option.command, option.value);
              }}
            >
              <Icon icon={option.icon} size={14} />
            </Button>
          </Tooltip>
        ))}
        <span className="rich-toolbar-spacer" />
        <Tooltip content="Undo">
          <Button type="button" size="icon" variant="ghost" aria-label="Undo" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); history('undo'); }}>
            <Icon icon={UndoIcon} size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="Redo">
          <Button type="button" size="icon" variant="ghost" aria-label="Redo" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); history('redo'); }}>
            <Icon icon={RedoIcon} size={14} />
          </Button>
        </Tooltip>
      </div>
      <div
        ref={editorRef}
        className="rich-editor-field"
        contentEditable={!disabled}
        role="textbox"
        aria-label="Coding objective"
        aria-multiline="true"
        aria-disabled={disabled}
        data-empty={empty}
        data-placeholder="What should the team deliver?"
        suppressContentEditableWarning
        onInput={emit}
        onFocus={refreshFormats}
        onKeyUp={refreshFormats}
        onMouseUp={refreshFormats}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          const currentLength = normalizeText(editorRef.current?.innerText ?? '').length;
          const text = event.clipboardData.getData('text/plain').slice(0, MAX_LENGTH - currentLength);
          document.execCommand('insertText', false, text);
          emit();
        }}
      />
    </div>
  );
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
