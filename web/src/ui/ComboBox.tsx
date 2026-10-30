// A dropdown you can type in (team trial round 12): the list keeps every option whose label contains what is typed,
// case-insensitive ("lon" finds Europe/London and America/Barcelona's neighbours alike), arrow keys move, Enter picks,
// Escape closes. Used for long lists such as countries, account managers and time zones.
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "./primitives";
import { matchOptions, type ComboOption } from "./comboMatch";

export type { ComboOption };

export function ComboBox({
  id,
  value,
  options,
  onChange,
  placeholder,
  emptyLabel,
  disabled,
  invalid,
}: {
  id?: string;
  value: string | number | null;
  options: ComboOption[];
  onChange: (v: string | number | null) => void;
  placeholder?: string;
  /** Offer "no value" first (optional fields). */
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const selected = options.find((o) => String(o.value) === String(value ?? ""));
  const list = useMemo(() => {
    const hits = matchOptions(options, text);
    return emptyLabel !== undefined && !text.trim() ? [{ value: "", label: emptyLabel }, ...hits] : hits;
  }, [options, text, emptyLabel]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = () => {
    setOpen(false);
    setText("");
  };
  const pick = (o: ComboOption) => {
    onChange(o.value === "" ? null : o.value);
    close();
  };
  const begin = () => {
    if (disabled) return;
    setText("");
    setOpen(true);
    const at = list.findIndex((o) => String(o.value) === String(value ?? ""));
    setActive(Math.max(0, at));
  };

  return (
    <>
      <input
        ref={input}
        id={id}
        className="combo-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-invalid={invalid}
        autoComplete="off"
        disabled={disabled}
        placeholder={open ? (selected?.label ?? placeholder) : placeholder}
        value={open ? text : (selected?.label ?? "")}
        onFocus={begin}
        onMouseDown={() => !open && document.activeElement === input.current && begin()}
        onBlur={close}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return begin();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((a) => Math.min(Math.max(0, a + step), Math.max(0, list.length - 1)));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (list[active]) pick(list[active]!);
          } else if (e.key === "Escape" && open) {
            e.stopPropagation();
            close();
          }
        }}
      />
      <Popover anchor={input} open={open} onClose={close} className="combo-pop">
        <div
          ref={listRef}
          className="combo-list"
          role="listbox"
          style={{ minWidth: input.current?.offsetWidth ?? 200 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {list.length === 0 && <div className="combo-empty muted small">No match</div>}
          {list.map((o, i) => (
            <div
              key={`${o.value}`}
              data-i={i}
              role="option"
              aria-selected={String(o.value) === String(value ?? "")}
              className={`combo-option${i === active ? " active" : ""}${
                String(o.value) === String(value ?? "") ? " selected" : ""
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
            >
              {o.label}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
