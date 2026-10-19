// Form kit for record screens (§5): one state object per form, a dirty flag for the tab's
// unsaved-changes dot (§13.5), and server field errors (problem+json `errors[].path`,
// e.g. "/address/city") shown under the matching field. Required fields carry a "*".
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { Icon } from "../ui/Icon";

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
      const list = (err.problem.errors ?? []) as { path: string; message: string }[];
      const mapped: Record<string, string> = {};
      for (const e of list) if (e.path && e.path !== "/") mapped[pointerToPath(e.path)] ??= e.message;
      setErrors(mapped);
      return list.length
        ? `${err.problem.title}: ${list.length} field${list.length === 1 ? "" : "s"} to check`
        : err.message;
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
}: {
  title: string;
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  actions?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <section className="fsection">
      <header>
        <h2>{title}</h2>
        {note && <span className="muted small">{note}</span>}
        <span className="fb-spacer" />
        {actions}
      </header>
      <div className={`fgrid cols-${columns}`}>{children}</div>
    </section>
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
}: BaseProps<T> & {
  placeholder?: string;
  maxLength?: number;
  type?: "text" | "email" | "url" | "password" | "tel";
  /** Empty text is sent as null (optional fields). */
  nullable?: boolean;
  autoComplete?: string;
}) {
  const id = useId();
  const v = form.get(path);
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide={wide} htmlFor={id}>
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
}: BaseProps<T> & { rows?: number; placeholder?: string }) {
  const id = useId();
  const v = form.get(path);
  return (
    <FormField label={label} required={required} error={form.error(path)} hint={hint} wide htmlFor={id}>
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
}: BaseProps<T> & { min?: number; max?: number; step?: number; suffix?: string }) {
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
}: BaseProps<T> & { options: Option[]; placeholder?: string }) {
  const id = useId();
  const v = form.get(path);
  const numeric = options.length > 0 && typeof options[0]!.value === "number";
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

export function CheckField<T>({ form, path, label, hint, disabled }: Omit<BaseProps<T>, "required">) {
  return (
    <div className="ff check">
      <label className="toggle-inline strong-label">
        <input
          type="checkbox"
          checked={form.get(path) === true}
          disabled={disabled}
          onChange={(e) => form.set(path, e.target.checked)}
        />
        {label}
      </label>
      {form.error(path) ? (
        <span className="ff-error">{form.error(path)}</span>
      ) : (
        hint && <span className="ff-hint">{hint}</span>
      )}
    </div>
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
}: BaseProps<T> & { placeholder?: string }) {
  const id = useId();
  const list = ((form.get(path) as string[] | null) ?? []).slice();
  const [draft, setDraft] = useState("");
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
      <div className={`tag-input${disabled ? " disabled" : ""}`}>
        {list.map((x, i) => (
          <span key={x} className={`chip${form.errors[`${path}.${i}`] ? " invalid" : ""}`}>
            {x}
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
        ))}
        {!disabled && (
          <input
            id={id}
            value={draft}
            placeholder={list.length ? "" : placeholder}
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
              const text = e.clipboardData.getData("text");
              if (/[,\s;]/.test(text)) {
                e.preventDefault();
                add(text);
              }
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
}: Omit<BaseProps<T>, "required"> & { options: Option[] }) {
  const list = (form.get(path) as (string | number)[] | null) ?? [];
  return (
    <FormField label={label} error={form.error(path)} hint={hint} wide={wide}>
      <div className="multi-check">
        {options.map((o) => (
          <label key={o.value} className="toggle-inline">
            <input
              type="checkbox"
              disabled={disabled}
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
