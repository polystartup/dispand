import { removeAuthDir } from "./auth-file.ts";

export default function globalTeardown() {
  removeAuthDir();
}
