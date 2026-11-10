import { createAuthClient } from "better-auth/react";

// The only place the Better Auth client is used (`auth-call.test.ts` enforces it): its calls
// resolve with `{ error }` on HTTP failures instead of rejecting, which is easy to ignore.
const authClient = createAuthClient();

/** Failure of an auth call, with nothing but a status the UI can map to a message (0: no response). */
export class AuthCallError extends Error {
  constructor(readonly status: number) {
    super("Authentication request failed");
  }
}

type Result<T> = { data: T | null; error: { status: number } | null };

/** Runs an auth client call; throws `AuthCallError` when it rejects and when it resolves with `error`. */
export async function authCall<T>(call: () => Promise<Result<T>>): Promise<T | null> {
  let result: Result<T>;
  try {
    result = await call();
  } catch {
    throw new AuthCallError(0);
  }
  if (result.error) throw new AuthCallError(result.error.status);
  return result.data;
}

/** Client-safe message for a failed auth call. */
export function authErrorMessage(error: unknown, invalidCredentials = "Wrong email or password."): string {
  const status = error instanceof AuthCallError ? error.status : 0;
  if (status === 401 || status === 400) return invalidCredentials;
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  return status === 0 ? "Could not reach the server. Try again." : "Something went wrong. Try again.";
}

export const signIn = (email: string, password: string) => authCall(() => authClient.signIn.email({ email, password }));

export const signOut = () => authCall(() => authClient.signOut());
