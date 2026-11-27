const KEY = "dispand-chunk-reload";
const WINDOW_MS = 60_000;

/** Reloads the page, once a minute at most: a file that is really gone would reload it forever. Whether it does. */
export function reloadOncePerMinute(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY)) < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // No storage to remember it in: never loop.
  }
  location.reload();
  return true;
}

/**
 * A tab that stays open across a deploy asks for files the new build no longer has. The router
 * reloads the page when a route's script is gone, but not when its stylesheet is, which Vite loads
 * first and reports as `vite:preloadError`: the page reloads then too (`reloadOncePerMinute`).
 * Otherwise the error goes on to the route's error boundary. Returns the listener's removal.
 */
export function reloadOnStyleError(): () => void {
  const onError = (event: Event) => {
    if (!(event as Event & { payload?: Error }).payload?.message.startsWith("Unable to preload CSS")) return;
    if (reloadOncePerMinute()) event.preventDefault();
  };
  window.addEventListener("vite:preloadError", onError);
  return () => window.removeEventListener("vite:preloadError", onError);
}
