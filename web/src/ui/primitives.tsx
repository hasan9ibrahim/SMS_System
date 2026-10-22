// Shared controls. Styling follows §15.3: one filled accent button per page (variant
// "primary"), all others outlined or plain; 7–10 px corners, 1 px borders.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "default" | "ghost" | "danger";
  icon?: IconName;
  small?: boolean;
};

export function Button({ variant = "default", icon, small, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${small ? " btn-sm" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={small ? 13 : 15} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      className={`icon-btn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/** Closes on outside click and Escape. */
export function useDismiss(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, refs]);
}

/** A floating panel anchored under (or above) an element, rendered in a portal. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = "start",
  className,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useDismiss(open, onClose, [panel, anchor]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const width = panel.current?.offsetWidth ?? 220;
    const height = panel.current?.offsetHeight ?? 0;
    let left = align === "end" ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = r.bottom + 4;
    if (top + height > window.innerHeight - 8 && r.top - height - 4 > 8) top = r.top - height - 4;
    setPos({ top, left });
  }, [open, anchor, align]);
  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      className={`popover${className ? ` ${className}` : ""}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** The page's main record action: shown in the action bar next to Clone and Delete, not under More. */
  main?: boolean;
  onSelect: () => void;
}

export function Menu({ items, onClose }: { items: (MenuItem | "separator")[]; onClose: () => void }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : <span className="menu-icon-space" />}
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
  onlyCloseButton = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Only × closes it: a click outside or Escape does nothing (New rule, team trial round 3). */
  onlyCloseButton?: boolean;
}) {
  useEffect(() => {
    if (onlyCloseButton) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onlyCloseButton]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => !onlyCloseButton && e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function StatusDot({
  tone,
  hollow,
  label,
}: {
  tone: "good" | "warning" | "error" | "neutral" | "accent";
  hollow?: boolean;
  label?: string;
}) {
  return (
    <span className={`dot dot-${tone}${hollow ? " dot-hollow" : ""}`} role="img" aria-label={label} title={label} />
  );
}
