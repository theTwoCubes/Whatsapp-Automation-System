import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

const ToastContext = createContext(null);

function ToastItem({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const dismiss = () => {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), 200);
  };

  return (
    <div
      role="status"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 180ms ease, transform 180ms ease',
      }}
      className="pointer-events-auto flex items-center gap-3 bg-white rounded-2xl px-4 py-3 shadow-lg border border-gray-100 w-full"
    >
      <p className="flex-1 text-sm font-medium text-gray-900 leading-snug break-words">
        {toast.message}
        {toast.action && (
          <button
            onClick={() => { toast.action.onClick?.(); dismiss(); }}
            className="ml-2 underline underline-offset-2 font-semibold text-sm text-gray-700"
          >
            {toast.action.label}
          </button>
        )}
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 text-gray-400 hover:text-gray-700 transition-colors"
      >
        <X size={14} />
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

  // All toasts last 1 second
  const show = useCallback((message, type = 'info', duration = 1000, action = null) => {
    const id = ++counterRef.current;
    setToasts((prev) => [...prev, { id, message, type, duration, action }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (msg, dur, action) => show(msg, 'success', dur ?? 1000, action),
    error:   (msg, dur, action) => show(msg, 'error',   dur ?? 1000, action),
    warning: (msg, dur, action) => show(msg, 'warning', dur ?? 1000, action),
    info:    (msg, dur, action) => show(msg, 'info',    dur ?? 1000, action),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="fixed right-4 z-[9999] flex flex-col gap-2 w-[300px] max-w-[calc(100vw-2rem)] pointer-events-none"
        style={{
          // Sit below mobile top navbar (safe-area-inset-top + 64px bar + 8px gap)
          top: 'max(1rem, calc(env(safe-area-inset-top) + 72px))',
        }}
        aria-live="polite"
      >
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
