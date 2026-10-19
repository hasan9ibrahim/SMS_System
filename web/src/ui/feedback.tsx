// Toasts (e.g. the 10-second "Undo" after a save, §13.10) and promise-based dialogs.
import type { ReactNode } from "react";
import { create } from "zustand";
import { Button, Modal } from "./primitives";
import { Icon } from "./Icon";

export interface Toast {
  id: number;
  tone: "info" | "good" | "warning" | "error";
  message: string;
  action?: { label: string; run: () => void };
  timeoutMs: number;
}

interface DialogEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

interface FeedbackState {
  toasts: Toast[];
  dialogs: DialogEntry[];
  push: (t: Omit<Toast, "id" | "timeoutMs"> & { timeoutMs?: number }) => number;
  dismiss: (id: number) => void;
  openDialog: (render: (close: () => void) => ReactNode) => void;
  closeDialog: (id: number) => void;
}

let seq = 0;

export const useFeedback = create<FeedbackState>((set, get) => ({
  toasts: [],
  dialogs: [],
  push: (t) => {
    const id = ++seq;
    const toast: Toast = { timeoutMs: 5000, ...t, id };
    set({ toasts: [...get().toasts.slice(-4), toast] });
    if (toast.timeoutMs > 0) setTimeout(() => get().dismiss(id), toast.timeoutMs);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  openDialog: (render) => set({ dialogs: [...get().dialogs, { id: ++seq, render }] }),
  closeDialog: (id) => set({ dialogs: get().dialogs.filter((d) => d.id !== id) }),
}));

export const toast = (t: Omit<Toast, "id" | "timeoutMs"> & { timeoutMs?: number }) => useFeedback.getState().push(t);

/** Opens a dialog and resolves with the value it closes with (null when dismissed). */
export function ask<T>(render: (resolve: (value: T | null) => void) => ReactNode): Promise<T | null> {
  return new Promise((resolve) => {
    useFeedback.getState().openDialog((close) =>
      render((value) => {
        close();
        resolve(value);
      }),
    );
  });
}

export function confirmDialog(opts: {
  title: string;
  message: ReactNode;
  ok: string;
  danger?: boolean;
}): Promise<boolean> {
  return ask<boolean>((done) => (
    <Modal
      title={opts.title}
      onClose={() => done(false)}
      width={440}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={opts.danger ? "danger" : "primary"} onClick={() => done(true)} autoFocus>
            {opts.ok}
          </Button>
        </>
      }
    >
      {opts.message}
    </Modal>
  )).then((v) => v === true);
}

export function FeedbackLayer() {
  const { toasts, dialogs, dismiss, closeDialog } = useFeedback();
  return (
    <>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
      {dialogs.map((d) => (
        <div key={d.id}>{d.render(() => closeDialog(d.id))}</div>
      ))}
    </>
  );
}
