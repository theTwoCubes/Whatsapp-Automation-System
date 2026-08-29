import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import Button from './Button.jsx';

export default function Modal({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  variant      = 'primary',
  onConfirm,
  onClose,
  busy         = false,
}) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="relative bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4 p-6 flex flex-col gap-4 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-labelledby="modal-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <h2 id="modal-title" className="text-base font-semibold text-gray-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-0.5 rounded flex-shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        {body && (
          <p className="text-sm text-gray-600 leading-relaxed">{body}</p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant} size="md" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
