'use client';

import type { LinkSuggestItem } from '@/lib/noteLinkSuggest';

type NoteLinkSuggestProps = {
  items: LinkSuggestItem[];
  activeIndex: number;
  top: number;
  left: number;
  onHover: (index: number) => void;
  onSelect: (item: LinkSuggestItem) => void;
};

export default function NoteLinkSuggest({
  items,
  activeIndex,
  top,
  left,
  onHover,
  onSelect,
}: NoteLinkSuggestProps) {
  if (!items.length) return null;

  return (
    <ul
      role="listbox"
      className="synapse-link-suggest absolute z-30 max-h-56 min-w-[14rem] max-w-[22rem] overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel)] py-1 text-xs shadow-lg"
      style={{ top, left }}
      aria-label="Note link suggestions"
    >
      {items.map((item, i) => (
        <li key={item.id} role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
              i === activeIndex
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--text)] hover:bg-[var(--surface-2)]'
            }`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
          >
            <span className="truncate font-medium">{item.label}</span>
            {item.detail ? (
              <span className="truncate text-[10px] text-[var(--muted)]">{item.detail}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
