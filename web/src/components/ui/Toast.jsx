import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, AlertTriangle, Info } from 'lucide-react';

const ToastContext = createContext(null);

// A single visual language for every notification: a soft coloured tile on the
// left carries the icon, a bold first line carries the message, and a thin bar
// underneath ticks down the auto-dismiss so the user can tell it isn't stuck.
const typeStyles = {
  success: {
    icon:  Check,
    tint:  '#10b981',
    tintBg: 'rgba(16, 185, 129, 0.12)',
  },
  error: {
    icon:  X,
    tint:  '#ef4444',
    tintBg: 'rgba(239, 68, 68, 0.12)',
  },
  warning: {
    icon:  AlertTriangle,
    tint:  '#f59e0b',
    tintBg: 'rgba(245, 158, 11, 0.14)',
  },
  info: {
    icon:  Info,
    tint:  '#3b82f6',
    tintBg: 'rgba(59, 130, 246, 0.12)',
  },
};

function ToastItem({ toast, onDismiss }) {
  const style = typeStyles[toast.type] || typeStyles.info;
  const Icon = style.icon;
  const [leaving, setLeaving] = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;
    const start = Date.now();
    const tick = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - start) / toast.duration) * 100);
      setProgress(pct);
    }, 30);
    return () => clearInterval(tick);
  }, [toast.duration]);

  const dismiss = () => {
    setLeaving(true);
    setTimeout(() => onDismiss(toast.id), 160);
  };

  return (
    <div
      role="status"
      className={`
        pointer-events-auto relative flex items-stretch gap-0 rounded-xl overflow-hidden bg-white
        shadow-[0_10px_24px_-8px_rgba(15,23,42,0.18),0_2px_4px_rgba(15,23,42,0.06)]
        border border-gray-200/70
        transition-all duration-150 ease-out
        ${leaving ? 'opacity-0 translate-x-3' : 'opacity-100 translate-x-0'}
      `}
      style={{ animation: leaving ? undefined : 'toast-slide 200ms ease-out' }}
    >
      {/* Icon */}
      <div className="flex items-center justify-center w-14 flex-shrink-0">
        <span style={{ color: style.tint }}>
          <Icon size={22} strokeWidth={2.5} />
        </span>
      </div>

      {/* Message + optional action + close */}
      <div className="flex-1 flex items-start gap-3 pl-2 pr-4 py-4 min-w-0">
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-base font-medium text-gray-900 leading-snug break-words">{toast.message}</p>
          {/* Optional action button (§4.7 extension) */}
          {toast.action && (
            <button
              onClick={() => { toast.action.onClick?.(); dismiss(); }}
              className="mt-1.5 text-sm font-semibold underline underline-offset-2"
              style={{ color: style.tint }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          onClick={dismiss}
          className="text-gray-400 hover:text-gray-700 transition-colors p-1 -mr-1 rounded flex-shrink-0"
          aria-label="Dismiss"
        >
          <X size={18} />
        </button>
      </div>

      {/* Countdown */}
      {toast.duration > 0 && (
        <div className="absolute bottom-0 left-14 right-0 h-[3px] bg-gray-100">
          <div
            className="h-full transition-[width] duration-75 ease-linear"
            style={{ width: `${progress}%`, background: style.tint }}
          />
        </div>
      )}
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message, type = 'info', duration = 2000, action = null) => {
    const id = ++counterRef.current;
    setToasts((prev) => [...prev, { id, message, type, duration, action }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (msg, dur, action) => show(msg, 'success', dur, action),
    error:   (msg, dur, action) => show(msg, 'error',   dur, action),
    warning: (msg, dur, action) => show(msg, 'warning', dur, action),
    info:    (msg, dur, action) => show(msg, 'info',    dur, action),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}

      <style>{`
        @keyframes toast-slide {
          from { opacity: 0; transform: translate(12px, -4px); }
          to   { opacity: 1; transform: translate(0, 0); }
        }
      `}</style>

      <div
        className="fixed top-6 right-6 z-50 flex flex-col gap-3 w-[420px] pointer-events-none"
        aria-live="polite"
      >
        {/* Cap at 3 most-recent toasts, show overflow count (§4.7) */}
        {toasts.length > 3 && (
          <div className="pointer-events-auto text-center text-xs text-gray-500 bg-white/80 rounded-full px-3 py-1 shadow-sm border border-gray-200 self-center">
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
