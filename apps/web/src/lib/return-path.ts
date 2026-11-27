/**
 * Where sign-in sends a person back: a path of this app (`/settings/plugins?add=…`), never another
 * site (`//host`, `/\host`, a scheme), nor a path a browser would rewrite into one (whitespace,
 * control characters, backslashes).
 */
export function returnPath(value: string | undefined): string | undefined {
  return value !== undefined && /^\/(?![/\\])[^\\\s\p{Cc}]*$/u.test(value) ? value : undefined;
}
