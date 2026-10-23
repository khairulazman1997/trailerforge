import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * Modal built on the native <dialog>: focus is trapped, Escape closes, the page behind is inert.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          <div className="dialog-content">{children}</div>
          <div className="dialog-footer">{footer}</div>
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button as destructive. */
  tone?: 'normal' | 'danger';
  /** Runs when confirmed; the dialog shows progress and closes when it settles. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps & { acknowledge?: string }) {
  const {
    open,
    title,
    children,
    confirmLabel,
    cancelLabel = 'Cancel',
    tone = 'normal',
    acknowledge,
  } = props;
  const [pending, setPending] = useState(false);
  const [ticked, setTicked] = useState(false);
  const cancel = () => {
    setTicked(false);
    props.onCancel();
  };
  const confirm = async () => {
    setPending(true);
    try {
      await props.onConfirm();
    } finally {
      setPending(false);
      setTicked(false);
    }
  };
  return (
    <Dialog
      open={open}
      title={title}
      onClose={cancel}
      footer={
        <>
          <button type="button" onClick={cancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={pending || (acknowledge !== undefined && !ticked)}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {acknowledge !== undefined && (
        <label className="acknowledge">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span>{acknowledge}</span>
        </label>
      )}
    </Dialog>
  );
}

/**
 * For actions that send data off this machine (LLM providers, deep scan): the user must tick
 * an explicit acknowledgement before the confirm button works.
 */
export function ConsentDialog(props: ConfirmDialogProps & { acknowledge: string }) {
  return <ConfirmDialog {...props} tone={props.tone ?? 'danger'} />;
}
