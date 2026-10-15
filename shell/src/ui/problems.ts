import type { ApiFailure, ApiResult } from "../proxy/client";

import { humanize } from "./features/api-clients/humanize";

/**
 * Turning a failed call into something a person can act on.
 *
 * Rules (docs/design/components.md → Callouts):
 *   - If retrying could fix it, retry first (`withRetry`); only show what's
 *     still wrong after that.
 *   - Say what happened in plain words, never internal names.
 *   - Offer one remedy, and only one the user can actually do. If there's
 *     nothing to do, say what Maximal is doing about it instead.
 *   - Keep the raw error for a "Details" disclosure, for bug reports.
 */

export type Remedy =
  /** Nothing for the user to do; the detail says what happens next. */
  | "none"
  /** Running the same thing again is reasonable (e.g. after fixing a file). */
  | "retry"
  /** Restart Maximal's background service. */
  | "restart"
  /** Sign in to GitHub on the Account page. */
  | "sign-in";

export interface Problem {
  title: string;
  detail: string;
  remedy: Remedy;
  /** The underlying error as reported, for the Details disclosure. */
  technical: string;
}

interface Context {
  /** What was being loaded or changed, for sentences: "your apps". */
  subject: string;
  /** Loading a list, or saving a change the user just made. */
  doing?: "load" | "save";
  /** The call went through to GitHub Copilot (its errors mean different things). */
  upstream?: boolean;
}

/** Worth retrying automatically: Maximal didn't answer, or a server hiccup. */
export function isTransient(failure: ApiFailure): boolean {
  return failure.status === 0 || failure.status === 429 || failure.status >= 502;
}

/** Re-run `call` while it fails transiently, then return the last result. */
export async function withRetry<T>(
  call: () => Promise<ApiResult<T>>,
  delaysMs: Array<number> = [500, 1500, 3500],
): Promise<ApiResult<T>> {
  let result = await call();
  for (const delay of delaysMs) {
    if (result.ok || !isTransient(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await call();
  }
  return result;
}

/** "/Users/ana/.claude.json" → "~/.claude.json". */
function tidyPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
}

/** The file a Node fs error names, e.g. "EACCES: permission denied, open '/x'". */
function fileIn(message: string): string | null {
  const m = /'([^']+)'/.exec(message);
  return m ? tidyPath(m[1]) : null;
}

export function describeProblem(
  failure: ApiFailure,
  { subject, doing = "load", upstream = false }: Context,
): Problem {
  const message = humanize(failure.error);
  const outcome = doing === "load" ? `${subject} can't load` : "your change didn't save";
  const technical = failure.status ? `HTTP ${failure.status}: ${message}` : message;

  // Maximal itself didn't answer (still failing after the automatic retries).
  if (failure.status === 0) {
    return {
      title: "Maximal isn't responding",
      detail: `Settings can't reach Maximal's background service, so ${outcome}. Restarting Maximal usually fixes this.`,
      remedy: "restart",
      technical,
    };
  }

  if (upstream) {
    if (failure.status === 401) {
      return {
        title: "You're not signed in to GitHub Copilot",
        detail: `Once you sign in on the Account page, Maximal loads ${subject} again by itself.`,
        remedy: "sign-in",
        technical,
      };
    }
    if (failure.status === 403) {
      return {
        title: "GitHub Copilot turned this down",
        detail: `${message} Check your Copilot plan or organization settings on GitHub.`,
        remedy: "none",
        technical,
      };
    }
    if (failure.status === 429) {
      return {
        title: "GitHub Copilot is limiting requests",
        detail: "Too many requests in a short time. Maximal tries again on its own in a few minutes.",
        remedy: "none",
        technical,
      };
    }
    if (failure.status >= 500) {
      return {
        title: "GitHub Copilot isn't answering",
        detail: "This is on GitHub's side, not your setup. Maximal keeps trying on its own.",
        remedy: "none",
        technical,
      };
    }
  }

  // Settings and Maximal disagree about the per-launch key: a restart re-pairs them.
  if (failure.status === 401 || failure.status === 403) {
    return {
      title: "Settings lost its connection to Maximal",
      detail: "Restarting Maximal reconnects them.",
      remedy: "restart",
      technical,
    };
  }

  // File-system errors, named by the file they're about.
  const file = fileIn(message);
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(message)) {
    return {
      title: "Maximal isn't allowed to change a file",
      detail: `It doesn't have permission to write ${file ?? "one of its settings files"}. Check the file's permissions, then try again.`,
      remedy: "retry",
      technical,
    };
  }
  if (/\bENOSPC\b/.test(message)) {
    return {
      title: "Your disk is full",
      detail: "Maximal couldn't save its settings. Free up some space, then try again.",
      remedy: "retry",
      technical,
    };
  }
  if (/JSON|Unexpected token|Unexpected end of/i.test(message)) {
    return {
      title: "A settings file has a mistake in it",
      detail: `${file ?? "One of the settings files"} isn't valid JSON, so Maximal left it alone. Fix or remove the broken part, then try again.`,
      remedy: "retry",
      technical,
    };
  }

  if (failure.status === 400) {
    return {
      title: "Maximal didn't understand the request",
      detail: "That's a bug in Maximal, not something you did. Restarting Maximal may clear it.",
      remedy: "restart",
      technical,
    };
  }

  return {
    title: doing === "load" ? `Maximal couldn't load ${subject}` : "Maximal couldn't save that change",
    detail: `${message} Restarting Maximal usually clears errors like this.`,
    remedy: "restart",
    technical,
  };
}
