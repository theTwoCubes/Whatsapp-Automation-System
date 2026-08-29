import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';

const ToastContext = createContext(null);

const typeStyles = {
  success: { bar: 'bg-white',    icon: <CheckCircle size={16} className="text-green-600 flex-shrink-0" />, border: 'border-green-200', text: 'text-gray-800' },
  error:   { bar: 'bg-white',    icon: <XCircle     size={16} className="text-red-500   flex-shrink-0" />, border: 'border-red-200',   text: 'text-gray-800' },
  warning: { bar: 'bg-white',    icon: <AlertTriangle size={16} className="text-amber-500 flex-shrink-0" />, border: 'border-amber-200', text: 'text-gray-800' },
  info:    { bar: 'bg-white',    icon: <CheckCircle size={16} className="text-[var(--accent)] flex-shrink-0" />, border: 'border-gray-200', text: 'text-gray-800' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++counterRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (msg, dur) => show(msg, 'success', dur),
    error:   (msg, dur) => show(msg, 'error', dur),
    warning: (msg, dur) => show(msg, 'warning', dur),
    info:    (msg, dur) => show(msg, 'info', dur),
    dismiss,
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}

      {/* Toast container — bottom-right */}
      <div
        className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-80 pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const s = typeStyles[t.type] || typeStyles.info;
          return (
            <div
              key={t.id}
              role="status"
              className={`
                pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg
                bg-white border ${s.border}
                animate-slide-up
              `}
            >
              {s.icon}
              <span className={`flex-1 text-sm ${s.text}`}>{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="text-gray-400 hover:text-gray-600 transition-colors p-0.5 flex-shrink-0 cursor-pointer rounded"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
