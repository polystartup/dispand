// What jsdom lacks and the chat's thread uses on mount (assistant-ui's viewport): no layout, no observers.
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoResizeObserver as never;
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollIntoView ??= function () {};
