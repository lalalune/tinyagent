"use client";

import { Modal } from "./Modal";
import { cx } from "@/lib/utils";

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            className={cx(tone === "danger" ? "btn-danger" : "btn-primary")}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {body && <p className="text-sm leading-relaxed text-slate-600">{body}</p>}
    </Modal>
  );
}
