// The Dashboard's one way to read the proxy that served it: a same-origin GET
// that turns an HTTP error into an Error carrying the status and the server's
// own message. Shared by main.ts and the live sessions controller.

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  // No client-side credentials: the proxy exempts the dashboard
  // endpoints from API-key auth when the request comes from
  // loopback. See createAuthMiddleware in src/lib/request-auth.ts.
  const response = await fetch(url, init);

  if (!response.ok) {
    let message = response.statusText || "Request failed";

    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as {
          error?: { message?: string };
          message?: string;
        };
        const apiMessage = payload?.error?.message || payload?.message;
        if (typeof apiMessage === "string" && apiMessage.trim()) {
          message = apiMessage.trim();
        }
      } else {
        const text = await response.text();
        if (text.trim()) {
          message = text.trim();
        }
      }
    } catch (error) {
      console.warn("Could not parse error response:", error instanceof Error ? error.message : String(error));
    }

    const error = new Error(
      `Request failed with status ${response.status}: ${message}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as T;
}
