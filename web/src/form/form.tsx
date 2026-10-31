// Form kit for record screens (§5): one state object per form, a dirty flag for the tab's
// unsaved-changes dot (§13.5), and server field errors (problem+json `errors[].path`,
// e.g. "/address/city") shown under the matching field. Required fields carry a "*".
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { fieldLine, problemFields, problemTitle } from "../api/problems";
import { Icon } from "../ui/Icon";
import { ComboBox } from "../ui/ComboBox";

import { getAt, pointerToPath, setAt } from "./paths";

export { getAt, pointerToPath, setAt };

export interface FormApi<T> {
  values: T;
  dirty: boolean;
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  /** The error for a field, or the first error inside it (e.g. one bad IP in a list). */
  error: (path: string) => string | undefined;
  errors: Record<string, string>;
  setErrors: (e: Record<string, string>) => void;
  reset: (next: T) => void;
  /** Maps a failed save to field errors; returns the message for the form banner. */
  fail: (err: unknown) => string;
}

export function useForm<T>(initial: T): FormApi<T> {
  const [values, setValues] = useState<T>(initial);
  const base = useRef(JSON.stringify(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useCallback((path: string, value: unknown) => {
    setValues((v) => setAt(v, path, value));
    setErrors((e) => {
      if (!Object.keys(e).some((k) => k === path || k.startsWith(`${path}.`))) return e;
      return Object.fromEntries(Object.entries(e).filter(([k]) => k !== path && !k.startsWith(`${path}.`)));
    });
  }, []);
  const reset = useCallback((next: T) => {
    base.current = JSON.stringify(next);
    setValues(next);
    setErrors({});
  }, []);
  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      // In plain words, each under its field (functional QA round 13); the banner names the ones with no field.
      const list = problemFields(err.problem);
      const mapped: Record<string, string> = {};
      for (const e of list) if (e.path) mapped[pointerToPath(e.path)] ??= e.message;
      setErrors(mapped);
      const loose = list.filter((e) => !e.path);
      if (!list.length) return err.message;
      const title = `${problemTitle(err.problem.title)}: ${list.length} field${list.length === 1 ? "" : "s"} to check`;
      return loose.length ? `${title}. ${loose.map(fieldLine).join(" ")}` : title;
    }
    return String(err);
  }, []);
  const dirty = useMemo(() => JSON.stringify(values) !== base.current, [values]);
  return {
    values,
    dirty,
    get: (path) => getAt(values, path),
    set,
    error: (path) => errors[path] ?? Object.entries(errors).find(([k]) => k.startsWith(`${path}.`))?.[1],
    errors,
    setErrors,
    reset,
    fail,
  };
}

// ---------------------------------------------------------------- layout

export function Section({
  title,
  children,
  columns = 3,
  actions,
  note,
  subtitle,
  id,
}: {
  title: string;
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  actions?: ReactNode;
  note?: ReactNode;
  /** One line under the title saying what the section is for (record redesign, team trial round 4). */
  subtitle?: ReactNode;
  /** Anchor for the "On this page" list. */
  id?: string;
}) {
  return (
    <section className="fsection" id={id}>
      <header>
        <div className="fsection-title">
          <h2>{title}</h2>
          {(subtitle ?? note) && <p className="fsection-sub">{subtitle ?? note}</p>}
        </div>
        <span className="fb-spacer" />
        {actions}
      </header>
      <div className={`fgrid cols-${columns}`}>{children}</div>
    </section>
  );
}

/**
 * Fields on the left and yes / no boxes stacked on the right, in one section (trunk Delivery receipts and Routing,
 * team trial round 12). Takes the section's whole width.
 */
export function FieldsAndChecks({
  fields,
  checks,
  columns = 2,
}: {
  fields: ReactNode;
  checks: ReactNode;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div className="fields-checks wide">
      <div className={`fgrid cols-${columns}`}>{fields}</div>
      <div className="check-stack">{checks}</div>
    </div>
  );
}

/** A small capitals heading across the grid, grouping fields inside a section (e.g. Endpoint, Credentials). */
export function SubHead({ children }: { children: ReactNode }) {
  return <h3 className="fsub wide">{children}</h3>;
}

/**
 * A short list of choices (record redesign, team trial round 4): `segmented` = joined buttons (Tier 1 / 2 / 3,
 * SMPP / HTTP), `cards` = radio cards (Customer / Vendor / Bilateral).
 */
export function ChoiceField<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  wide,
  options,
  variant = "segmented",
}: BaseProps<T> & { options: Option[]; variant?: "segmented" | "cards" }) {
  const v = form.get(path);
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide}>
      <div className={variant === "cards" ? "choice-cards" : "choice-seg"} role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const on = v === o.value;
          const off = disabled || o.disabled;
          return (
            <label key={o.value} className={`${on ? "on" : ""}${off ? " disabled" : ""}`} title={o.hint}>
              <input
                type="radio"
                checked={on}
                disabled={off}
                onChange={() => form.set(path, o.value)}
                className={variant === "cards" ? "" : "sr-only"}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </FormField>
  );
}

/** Active / inactive as a checkbox card that says what it means (record redesign, team trial round 4). */
export function StatusField<T>({
  form,
  path,
  label = "Status",
  required,
  disabled,
  onText,
  offText = "Inactive",
}: Omit<BaseProps<T>, "label"> & { label?: string; onText: string; offText?: string }) {
  const on = form.get(path) === "active";
  return (
    <FormField label={label} required={required} error={form.error(path)}>
      <label className={`status-card${on ? " on" : ""}`}>
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => form.set(path, e.target.checked ? "active" : "inactive")}
        />
        <span>{on ? onText : offText}</span>
      </label>
    </FormField>
  );
}

/** A yes / no setting as a card with its explanation and the box on the right (Alerts, team trial round 4). */
export function ToggleCard<T>({
  form,
  path,
  label,
  hint,
  disabled,
}: Omit<BaseProps<T>, "required" | "hint"> & { hint: string }) {
  const on = form.get(path) === true;
  return (
    <label className={`toggle-card${on ? " on" : ""}`}>
      <span className="toggle-card-text">
        <span className="strong">{label}</span>
        <span className="muted small">{hint}</span>
      </span>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => form.set(path, e.target.checked)} />
    </label>
  );
}

interface BaseProps<T> {
  form: FormApi<T>;
  path: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
  wide?: boolean;
}

export function FormField({
  label,
  required,
  error,
  hint,
  wide,
  children,
  htmlFor,
}: {
  label: string;
  required?: boolean | undefined;
  error?: string | undefined;
  hint?: ReactNode;
  wide?: boolean | undefined;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`ff${error ? " invalid" : ""}${wide ? " wide" : ""}`}>
      <label className="ff-label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <span className="ff-error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="ff-hint">{hint}</span>
      )}
    </div>
  );
}

export function TextField<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  wide,
  placeholder,
  maxLength,
  type = "text",
  nullable = true,
  autoComplete,
  trailing,
}: BaseProps<T> & {
  placeholder?: string;
  maxLength?: number;
  type?: "text" | "email" | "url" | "password" | "tel";
  /** Empty text is sent as null (optional fields). */
  nullable?: boolean;
  autoComplete?: string;
  /** Small buttons inside the box on the right, e.g. Copy (team trial round 12). */
  trailing?: ReactNode;
}) {
  const id = useId();
  const v = form.get(path);
  const box = (
    <input
      id={id}
      type={type}
      value={v == null ? "" : String(v)}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      required={required}
      autoComplete={autoComplete ?? "off"}
      aria-invalid={!!form.error(path)}
      onChange={(e) => form.set(path, e.target.value === "" && nullable && !required ? null : e.target.value)}
    />
  );
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
      {trailing ? (
        <span className="input-actions">
          {box}
          <span className="input-actions-buttons">{trailing}</span>
        </span>
      ) : (
        box
      )}
    </FormField>
  );
}

export function TextArea<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  rows = 3,
  placeholder,
  wide = true,
}: BaseProps<T> & { rows?: number; placeholder?: string }) {
  const id = useId();
  const v = form.get(path);
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
      <textarea
        id={id}
        rows={rows}
        value={v == null ? "" : String(v)}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => form.set(path, e.target.value === "" ? null : e.target.value)}
      />
    </FormField>
  );
}

export function NumberField<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  wide,
  min,
  max,
  step,
  suffix,
  placeholder,
}: BaseProps<T> & { min?: number; max?: number; step?: number; suffix?: string; placeholder?: string }) {
  const id = useId();
  const v = form.get(path);
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
      <span className="input-suffix">
        <input
          id={id}
          type="number"
          className="num"
          value={v == null ? "" : String(v)}
          min={min}
          max={max}
          step={step ?? "any"}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-invalid={!!form.error(path)}
          onChange={(e) => form.set(path, e.target.value === "" ? null : Number(e.target.value))}
        />
        {suffix && <span className="muted">{suffix}</span>}
      </span>
    </FormField>
  );
}

export interface Option {
  value: string | number;
  label: string;
  /** Not available here (ChoiceField greys it out, with `hint` as its tooltip). */
  disabled?: boolean;
  hint?: string;
}

export function SelectField<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  wide,
  options,
  placeholder = "—",
  searchable,
}: BaseProps<T> & {
  options: Option[];
  placeholder?: string;
  /** Type to filter the list: any option containing the text (long lists, team trial round 12). */
  searchable?: boolean;
}) {
  const id = useId();
  const v = form.get(path);
  const numeric = options.length > 0 && typeof options[0]!.value === "number";
  if (searchable)
    return (
      <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
        <ComboBox
          id={id}
          value={v == null ? null : (v as string | number)}
          options={options}
          disabled={disabled}
          invalid={!!form.error(path)}
          placeholder="Type to search…"
          {...(required ? {} : { emptyLabel: placeholder })}
          onChange={(x) => form.set(path, x === null ? null : numeric ? Number(x) : x)}
        />
      </FormField>
    );
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
      <select
        id={id}
        value={v == null ? "" : String(v)}
        disabled={disabled}
        required={required}
        aria-invalid={!!form.error(path)}
        onChange={(e) =>
          form.set(path, e.target.value === "" ? null : numeric ? Number(e.target.value) : e.target.value)
        }
      >
        {(!required || v == null) && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}

/** A yes / no box; the whole cell (label and hint) toggles it, not only the small box (team trial round 12). */
export function CheckField<T>({ form, path, label, hint, disabled }: Omit<BaseProps<T>, "required">) {
  return (
    <label className={`ff check${disabled ? " disabled" : ""}`}>
      <span className="toggle-inline strong-label">
        <input
          type="checkbox"
          checked={form.get(path) === true}
          disabled={disabled}
          onChange={(e) => form.set(path, e.target.checked)}
        />
        {label}
      </span>
      {form.error(path) ? (
        <span className="ff-error">{form.error(path)}</span>
      ) : (
        hint && <span className="ff-hint">{hint}</span>
      )}
    </label>
  );
}

/** A list of short values (emails, IP addresses) typed one by one; Enter or comma adds. */
export function ListField<T>({
  form,
  path,
  label,
  required,
  hint,
  disabled,
  wide,
  placeholder,
  keepPlaceholder,
}: BaseProps<T> & {
  placeholder?: string;
  /** Show the placeholder after the first value too (e.g. "+ Add email" under the list). */
  keepPlaceholder?: boolean;
}) {
  const id = useId();
  const list = ((form.get(path) as string[] | null) ?? []).slice();
  const [draft, setDraft] = useState("");
  // A value being edited in place (click it, team trial round 12): Enter or leaving keeps the change, Escape not.
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const commitEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    setEditing(null);
    if (text === list[editing.i]) return;
    if (!text)
      form.set(
        path,
        list.filter((_, j) => j !== editing.i),
      );
    else if (!list.some((x, j) => j !== editing.i && x === text))
      form.set(
        path,
        list.map((x, j) => (j === editing.i ? text : x)),
      );
  };
  const add = (text: string) => {
    const parts = text
      .split(/[,\s;]+/)
      .map((x) => x.trim())
      .filter((x) => x && !list.includes(x));
    if (parts.length) form.set(path, [...list, ...parts]);
    setDraft("");
  };
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
      {/* A click anywhere in the box puts the cursor in it, so Ctrl+V lands there (team trial round 7). */}
      <div
        className={`tag-input${disabled ? " disabled" : ""}`}
        onMouseDown={(e) => {
          if (disabled || e.target !== e.currentTarget) return;
          e.preventDefault();
          document.getElementById(id)?.focus();
        }}
      >
        {list.map((x, i) =>
          editing?.i === i ? (
            <input
              key={x}
              className="chip-edit"
              aria-label={`Edit ${x}`}
              autoFocus
              value={editing.text}
              onChange={(e) => setEditing({ i, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
              onBlur={commitEdit}
            />
          ) : (
            <span key={x} className={`chip${form.errors[`${path}.${i}`] ? " invalid" : ""}`}>
              <span
                className={disabled ? "chip-text" : "chip-text editable"}
                title={disabled ? undefined : "Click to edit"}
                {...(disabled
                  ? {}
                  : {
                      role: "button",
                      tabIndex: 0,
                      onClick: () => setEditing({ i, text: x }),
                      onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && setEditing({ i, text: x }),
                    })}
              >
                {x}
              </span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${x}`}
                  onClick={() =>
                    form.set(
                      path,
                      list.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          ),
        )}
        {!disabled && (
          <input
            id={id}
            value={draft}
            placeholder={list.length && !keepPlaceholder ? "" : placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(draft);
              }
              if (e.key === "Backspace" && !draft && list.length) form.set(path, list.slice(0, -1));
            }}
            onBlur={() => draft && add(draft)}
            onPaste={(e) => {
              // A paste is added at once (team trial round 3), so Save right after it keeps it. Emails are picked out
              // of text such as "Ann Lee <ann@acme.example>; bob@acme.example".
              const text = e.clipboardData.getData("text");
              if (!text.trim()) return;
              e.preventDefault();
              const emails = text.match(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[^\s<>,;:"'()[\]]+/g);
              add(emails ? emails.join(",") : `${draft}${text}`);
            }}
          />
        )}
      </div>
    </FormField>
  );
}

/** Several enum values as check boxes, stored as an array. */
export function MultiCheck<T>({
  form,
  path,
  label,
  hint,
  disabled,
  wide,
  options,
  any,
}: Omit<BaseProps<T>, "required"> & {
  options: Option[];
  /** Offers "Any": null means no restriction (e.g. vendor trunk data codings, TON, NPI, §5.5). */
  any?: boolean;
}) {
  const value = form.get(path) as (string | number)[] | null;
  const isAny = !!any && value == null;
  const list = value ?? [];
  return (
    <FormField label={label} error={form.error(path)} hint={hint} wide={wide}>
      <div className="multi-check">
        {any && (
          <label className="toggle-inline">
            <input
              type="checkbox"
              disabled={disabled}
              checked={isAny}
              onChange={(e) => form.set(path, e.target.checked ? null : [])}
            />
            Any
          </label>
        )}
        {options.map((o) => (
          <label key={o.value} className="toggle-inline">
            <input
              type="checkbox"
              disabled={disabled || isAny}
              checked={list.includes(o.value)}
              onChange={(e) =>
                form.set(
                  path,
                  e.target.checked
                    ? options.map((x) => x.value).filter((x) => x === o.value || list.includes(x))
                    : list.filter((x) => x !== o.value),
                )
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    </FormField>
  );
}

/** A read-only value in the form layout. */
export function ReadOnly({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <FormField label={label} hint={hint}>
      <div className="ff-readonly">{children}</div>
    </FormField>
  );
}

export function FormBanner({ message, onClose }: { message: string | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <div className="form-banner" role="alert">
      <Icon name="alert" size={15} />
      <span>{message}</span>
      <span className="fb-spacer" />
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}
