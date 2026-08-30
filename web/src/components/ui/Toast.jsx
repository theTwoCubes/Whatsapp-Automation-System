import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

const ToastContext = createContext(null);

// Plain, minimal toast: a solid-coloured left border, message text, dismiss X.
// No icon, no countdown bar, no animation beyond a simple slide-in.
const typeStyles = {
  success: { border: '#10b981', bg: '#f0fdf4', text: '#065f46' },
  error:   { border: '#ef4444', bg: '#fef2f2', text: '#991b1b' },
  warning: { border: '#f59e0b', bg: '#fffbeb', text: '#92400e' },
  info:    { border: '#3b82f6', bg: '#eff6ff', text: '#1e40af' },
};

function ToastItem({ toast, onDismiss }) {
  const style = typeStyles[toast.type] || typeStyles.info;
  const [visible, setVisible] = useState(false);

  // Trigger enter animation on mount
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const dismiss = () => {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), 200);
  };

  return (
    <div
      role="status"
      style={{
        borderLeft: `4px solid ${style.border}`,
        background: style.bg,
        color: style.text,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-6px)',
        transition: 'opacity 200ms ease, transform 200ms ease',
      }}
      className="pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-3 shadow-md w-full"
    >
      <p className="flex-1 text-sm font-medium leading-snug break-words">
        {toast.message}
        {toast.action && (
          <button
            onClick={() => { toast.action.onClick?.(); dismiss(); }}
            className="ml-2 underline underline-offset-2 font-semibold text-sm"
            style={{ color: style.border }}
          >
            {toast.action.label}
          </button>
        )}
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message, type = 'info', duration = 3500, action = null) => {
    const id = ++counterRef.current;
    setToasts((prev) => [...prev, { id, message, type, duration, action }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (msg, dur, action) => show(msg, 'success', dur ?? 3500, action),
    error:   (msg, dur, action) => show(msg, 'error',   dur ?? 5000, action),
    warning: (msg, dur, action) => show(msg, 'warning', dur ?? 4000, action),
    info:    (msg, dur, action) => show(msg, 'info',    dur ?? 3500, action),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)] pointer-events-none"
        aria-live="polite"
      >
        {/* Cap at 3 most-recent */}
        {toasts.length > 3 && (
          <div className="pointer-events-auto text-center text-xs text-gray-500 bg-white rounded-full px-3 py-1 shadow-sm border border-gray-200 self-center">
            +{toasts.length - 3} more
          </div>
        )}
        {toasts.slice(-3).map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
