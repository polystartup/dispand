// What a Node process spends, sampled once a second: CPU (all its threads), how busy its event loop
// was (utilization) and how late its timers ran (delay), and memory. The harness samples itself
// with `sampler`; the app loads this file as a preload (`node --import`), and with
// DISPAND_BENCH_PROBE set it appends one JSON line per second to that file.
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type Sample = {
  /** Wall clock, ms. */
  t: number;
  /** CPU of the whole process over the second, in cores (1 = one core busy all the time). */
  cpu: number;
  /** Share of the second the event loop spent running code rather than waiting (0 to 1). */
  elu: number;
  /** How late the event loop ran a timer over the second, ms (the monitor's 10 ms period taken off). */
  lagP50: number;
  lagP99: number;
  lagMax: number;
  rssMb: number;
  heapMb: number;
};

export function sampler(onSample: (sample: Sample) => void, everyMs = 1000): () => void {
  const resolution = 10;
  const delay = monitorEventLoopDelay({ resolution });
  delay.enable();
  let cpu = process.cpuUsage();
  let elu = performance.eventLoopUtilization();
  let at = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpuNow = process.cpuUsage();
    const eluNow = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    onSample({
      t: Date.now(),
      cpu: (cpuNow.user - cpu.user + cpuNow.system - cpu.system) / 1000 / (now - at),
      elu: performance.eventLoopUtilization(eluNow, elu).utilization,
      lagP50: Math.max(0, delay.percentile(50) / 1e6 - resolution),
      lagP99: Math.max(0, delay.percentile(99) / 1e6 - resolution),
      lagMax: Math.max(0, delay.max / 1e6 - resolution),
      rssMb: memory.rss / 2 ** 20,
      heapMb: memory.heapUsed / 2 ** 20,
    });
    delay.reset();
    [cpu, elu, at] = [cpuNow, eluNow, now];
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

const out = process.env.DISPAND_BENCH_PROBE;
if (out) sampler((sample) => appendFileSync(out, `${JSON.stringify(sample)}\n`));
