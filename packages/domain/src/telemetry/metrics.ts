// Every metric instrument, with the only attributes it may carry. An instrument is created with
// `meter(...)` under one of these names; any attribute not listed here is dropped by its view.
export const METRICS = {
  "dispand.rpc.duration": ["rpc.method", "dispand.result"],
} as const satisfies Record<string, readonly string[]>;

export type MetricName = keyof typeof METRICS;
