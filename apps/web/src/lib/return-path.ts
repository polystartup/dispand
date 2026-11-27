/**
 * Where sign-in sends a person back: a path of this app (`/settings/plugins?add=…`, encoded as the
 * guard writes it), never another site (`//host`, `/\host`, a scheme), nor a path a browser would
 * rewrite into one or a header can't carry: printable ASCII only, no space and no backslash.
 */
export function returnPath(value: string | undefined): string | undefined {
  return value !== undefined && /^\/(?![/\\])[!-[\]-~]*$/.test(value) ? value : undefined;
}
