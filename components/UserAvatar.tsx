'use client';

/** Deterministic “random” avatar colour from a seed (stable across reloads). */
export function avatarHue(seed: string | number): number {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function avatarInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

interface UserAvatarProps {
  userId: number;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-14 w-14 text-lg',
};

export default function UserAvatar({ userId, name, size = 'md', className = '' }: UserAvatarProps) {
  const hue = avatarHue(userId);
  const initials = avatarInitials(name);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight text-[var(--accent-fg)] ring-1 ring-white/10 ${SIZES[size]} ${className}`}
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 48% 42%), hsl(${(hue + 36) % 360} 52% 28%))`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
