"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "@/lib/utils";

type ToastKind = "success" | "error" | "info" | "loading";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastApi {
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const scheduleAutoDismiss = useCallback(
    (id: number, kind: ToastKind) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      if (kind === "loading") {
        timers.current.delete(id);
        return;
      }
      const ms = kind === "error" ? 7000 : 4500;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = idRef.current++;
      setToasts((prev) => [...prev, { ...t, id }]);
      scheduleAutoDismiss(id, t.kind);
      return id;
    },
    [scheduleAutoDismiss],
  );

  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
      if (patch.kind) scheduleAutoDismiss(id, patch.kind);
    },
    [scheduleAutoDismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({ push, update, dismiss }),
    [push, update, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const ring =
    toast.kind === "success"
      ? "ring-blue-500/40"
      : toast.kind === "error"
        ? "ring-red-500/40"
        : toast.kind === "loading"
          ? "ring-blue-500/40"
          : "ring-slate-300";

  return (
    <div
      className={cx(
        "card pointer-events-auto flex animate-fade-in items-start gap-3 p-3.5 ring-1",
        ring,
      )}
    >
      <div className="mt-0.5 shrink-0">
        <ToastIcon kind={toast.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">{toast.title}</p>
        {toast.message && (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            {toast.message}
          </p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-1 text-slate-400 transition hover:text-slate-600"
        aria-label="Dismiss"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "loading") {
    return (
      <svg
        className="animate-spin text-blue-600"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="3"
          opacity="0.25"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const color =
    kind === "success"
      ? "text-blue-600"
      : kind === "error"
        ? "text-red-600"
        : "text-slate-600";
  const path =
    kind === "success"
      ? "M20 6 9 17l-5-5"
      : kind === "error"
        ? "M12 8v5M12 16h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z"
        : "M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z";
  return (
    <svg
      className={color}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
