'use client';

// Minimal toast notifications. The container is an ARIA live region, so screen readers
// announce new toasts without moving keyboard focus.

import { createContext, useCallback, useContext, useState } from 'react';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error' | 'live';
}

type Push = (message: string, tone?: Toast['tone']) => void;
const ToastContext = createContext<Push | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback<Push>(
    (message, tone = 'info') => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { id, message, tone }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[1000] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ${
              t.tone === 'error'
                ? 'border-danger/40 bg-danger-soft text-danger'
                : t.tone === 'success'
                  ? 'border-verified/40 bg-verified-soft text-verified'
                  : 'border-line bg-surface text-ink'
            }`}
          >
            {t.tone === 'live' ? <span className="rec-dot mt-1.5 shrink-0" data-live="true" aria-hidden="true" /> : null}
            <p className="flex-1 text-sm font-semibold">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-m-1 rounded p-1 text-sm text-muted hover:text-ink"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Push {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
