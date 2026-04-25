'use client';

import { useEffect, useState, useCallback } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let _addToast: ((message: string, type: ToastType) => void) | null = null;

export function toast(message: string, type: ToastType = 'info') {
  _addToast?.(message, type);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  let counter = 0;

  const add = useCallback((message: string, type: ToastType) => {
    const id = Date.now() + counter++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    _addToast = add;
    return () => {
      _addToast = null;
    };
  }, [add]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            'flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium pointer-events-auto',
            t.type === 'success' ? 'bg-green-600 text-white' : '',
            t.type === 'error' ? 'bg-red-600 text-white' : '',
            t.type === 'info' ? 'bg-gray-800 text-white' : '',
          ].join(' ')}
        >
          <span>
            {t.type === 'success' && '✅'}
            {t.type === 'error' && '❌'}
            {t.type === 'info' && 'ℹ️'}
          </span>
          {t.message}
        </div>
      ))}
    </div>
  );
}