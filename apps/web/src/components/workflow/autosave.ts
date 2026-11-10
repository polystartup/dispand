export type SaveState = "saved" | "unsaved" | "saving" | "error";

/**
 * Debounced, serialized saves: `change` keeps only the latest value and saves it `delayMs` after
 * the last change; one save runs at a time, and when it settles the latest pending value (if any)
 * goes next. The state is "saved" only when nothing is pending or in flight, and `saved` hears
 * only results no newer value is waiting behind.
 */
export class Autosaver<T, R> {
  private pending: T | null = null;
  private inFlight: Promise<void> | null = null;
  /** The debounce fired (or `flush` was called) while a save was in flight. */
  private due = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly save: (value: T) => Promise<R>,
    private on: { state: (state: SaveState) => void; saved: (result: R) => void },
    private readonly delayMs = 800,
  ) {}

  /** The state as last reported. */
  state: SaveState = "saved";

  /** Hands the reports to someone else (an editor mounting again): saves already queued go on. */
  listen(on: { state: (state: SaveState) => void; saved: (result: R) => void }): void {
    this.on = on;
    on.state(this.state);
  }

  private report(state: SaveState) {
    this.state = state;
    this.on.state(state);
  }

  change(value: T): void {
    this.pending = value;
    this.report("unsaved");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.delayMs);
  }

  /** The value waiting to be saved, if any. */
  get latest(): T | null {
    return this.pending;
  }

  /** Saves what is pending now (after the save in flight), without waiting for the debounce. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.run();
    while (this.inFlight) await this.inFlight;
  }

  private async run(): Promise<void> {
    if (this.inFlight) {
      this.due = true;
      return;
    }
    const value = this.pending;
    if (value === null) return;
    this.pending = null;
    this.due = false;
    this.report("saving");
    let failed = false;
    this.inFlight = this.save(value).then(
      // A newer value waiting means this result is already stale: only the latest save's result counts.
      (result) => {
        if (this.pending === null) this.on.saved(result);
      },
      () => {
        failed = true;
        // Kept for the next try, unless something newer replaced it.
        this.pending ??= value;
      },
    );
    await this.inFlight;
    this.inFlight = null;
    if (this.pending !== null && (this.due || failed === false)) {
      if (this.due) return this.run();
      this.report("unsaved");
      return;
    }
    this.report(failed ? "error" : "saved");
  }
}

const savers = new Map<string, Autosaver<unknown, unknown>>();

/**
 * The one saver of `key` (a workflow) for the page's lifetime: an editor that leaves and comes
 * back keeps the same queue, so an older pending save can never land after a newer one.
 */
export function saverFor<T, R>(key: string, create: () => Autosaver<T, R>): Autosaver<T, R> {
  let saver = savers.get(key) as Autosaver<T, R> | undefined;
  if (!saver) savers.set(key, (saver = create()) as Autosaver<unknown, unknown>);
  return saver;
}
