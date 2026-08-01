'use client';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  altConfirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onAltConfirm?: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  altConfirmLabel,
  danger,
  onConfirm,
  onAltConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl shadow-black/40"
      >
        <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{message}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          {altConfirmLabel && onAltConfirm && (
            <button type="button" className="btn-ghost" onClick={onAltConfirm}>
              {altConfirmLabel}
            </button>
          )}
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
