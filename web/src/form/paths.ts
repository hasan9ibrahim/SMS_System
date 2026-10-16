// Path helpers for the form kit: read and write nested form values by "a.b.c" path, and turn
// a problem+json error pointer ("/address/city") into the same path.
type Obj = Record<string, unknown>;

export function getAt(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

/** Immutable set: copies only the objects on the path. */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const base = (obj ?? {}) as Obj;
  const copy: Obj = Array.isArray(base) ? ([...base] as unknown as Obj) : { ...base };
  copy[head!] = rest.length ? setAt(base[head!], rest.join("."), value) : value;
  return copy as T;
}

/** "/address/city" -> "address.city" */
export const pointerToPath = (p: string) => p.replace(/^\//, "").replaceAll("/", ".");
