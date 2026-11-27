const KEY = "dispand-chunk-reload";
const WINDOW_MS = 60_000;

/**
 * A tab that stays open across a deploy asks for chunks the new build no longer has. Vite reports
 * a failed chunk load as `vite:preloadError`: the page reloads, once a minute at most (a chunk that
 * is really gone would reload forever), to get the new build. Otherwise the error goes on to the
 * route's error boundary, which offers a retry. Returns the listener's removal.
 */
export function reloadOnChunkError(): () => void {
  const onError = (event: Event) => {
    try {
      if (Date.now() - Number(sessionStorage.getItem(KEY)) < WINDOW_MS) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return; // No storage to remember it in: never loop.
    }
    event.preventDefault();
    location.reload();
  };
  window.addEventListener("vite:preloadError", onError);
  return () => window.removeEventListener("vite:preloadError", onError);
}
