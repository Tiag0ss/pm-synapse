'use client';

import {
  DEFAULT_NOTE_ICON,
  NOTE_ICON_PATHS,
  normalizeNoteIcon,
  type NoteIconId,
} from '@/lib/noteIcons';

interface NoteIconProps {
  icon?: string | null;
  className?: string;
  size?: number;
  title?: string;
}

export default function NoteIcon({ icon, className = '', size = 16, title }: NoteIconProps) {
  const id = normalizeNoteIcon(icon) || DEFAULT_NOTE_ICON;
  const paths = NOTE_ICON_PATHS[id] || NOTE_ICON_PATHS.note;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export type { NoteIconId };
