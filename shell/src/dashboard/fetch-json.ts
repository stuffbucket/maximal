// The Dashboard's one way to read the proxy that served it: a same-origin GET
// that turns an HTTP error into an Error carrying the status, machine-readable
// API code, and server message. Shared by main.ts and the live sessions controller.

export interface FetchJsonError extends Error {
  status: number;
  code?: string;
}

export function isFetchJsonError(error: unknown): error is FetchJsonError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; code?: unknown };
  return (
    typeof candidate.status === "number" &&
    (candidate.code === undefined || typeof candidate.code === "string")
  );
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  // No client-side credentials: the proxy exempts the dashboard
  // endpoints from API-key auth when the request comes from
  // loopback. See createAuthMiddleware in src/lib/request-auth.ts.
  const response = await fetch(url, init);

  if (!response.ok) {
    let message = response.statusText || "Request failed";
    let code: string | undefined;

    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as {
          error?: string | { code?: string; message?: string };
          code?: string;
          message?: string;
        };
        if (typeof payload.error === "string") {
          code = payload.error.trim() || undefined;
          message = payload.message?.trim() || code || message;
        } else {
          code =
            payload.error?.code?.trim() || payload.code?.trim() || undefined;
          const apiMessage = payload.error?.message || payload.message;
          if (typeof apiMessage === "string" && apiMessage.trim()) {
            message = apiMessage.trim();
          }
        }
      } else {
        const text = await response.text();
        if (text.trim()) {
          message = text.trim();
        }
      }
    } catch (error) {
      console.warn(
        "Could not parse error response:",
        error instanceof Error ? error.message : String(error),
      );
    }

    const error = new Error(
      `Request failed with status ${response.status}: ${message}`,
    ) as FetchJsonError;
    error.status = response.status;
    error.code = code;
    throw error;
  }

  return (await response.json()) as T;
}
