import type { Shell } from "./contract.ts";

/** No shell: what `#web-shell` is unless the build names one with `DISPAND_WEB_SHELL`. */
const none: Shell = {};
export default none;
