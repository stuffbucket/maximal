import { useEffect, useState } from "react";

import {
  browserApiKey,
  browserAuthRequired,
  clearBrowserApiKey,
  onBrowserAuthRequired,
  saveBrowserApiKey,
} from "../../../proxy/browser-auth";
import { apiCall } from "../../../proxy/client";

import {
  BrowserAccessButton,
  type BrowserAuthError,
  BrowserAuthDialog,
} from "./BrowserAuthDialog";

interface BrowserAuthProps {
  /** Reload the page at the same address. Injected for tests. */
  reload?: () => void;
}

/**
 * Plain-browser access to a Maximal that requires API keys. Opens when a
 * Settings call meets Maximal's key challenge (or a Connect action asks),
 * checks the typed key with a read-only request, keeps it in this tab's
 * session storage, then reloads at the same deep link: every section and
 * live stream starts over with the key, and nothing that was refused is sent
 * again. Never mounted in the app, whose shell supplies its own key.
 */
export function BrowserAuth({
  reload = () => window.location.reload(),
}: BrowserAuthProps): JSX.Element {
  const [open, setOpen] = useState(browserAuthRequired);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BrowserAuthError | null>(null);
  const [, setLocaleTick] = useState(0);

  useEffect(() => {
    const ask = (): void => {
      setError(null);
      setOpen(true);
    };
    const unsubscribe = onBrowserAuthRequired(ask);
    // A call can meet the challenge before this effect subscribes.
    if (browserAuthRequired()) ask();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const repaint = (): void => setLocaleTick((tick) => tick + 1);
    window.addEventListener("maximal:locale-changed", repaint);
    return () => window.removeEventListener("maximal:locale-changed", repaint);
  }, []);

  const connect = async (key: string): Promise<void> => {
    setBusy(true);
    setError(null);
    // Read-only, and passed as an override so a refusal here leaves the
    // stored state alone.
    const result = await apiCall(
      {
        kind: "auth-status",
        method: "GET",
        path: "/settings/api/auth/github/status",
      },
      { apiKey: key },
    );
    if (!result.ok) {
      setError(result.authRequired ? "invalid" : "unavailable");
      setBusy(false);
      return;
    }
    try {
      saveBrowserApiKey(key);
    } catch {
      setError("storage");
      setBusy(false);
      return;
    }
    reload();
  };

  const connected = browserApiKey() !== undefined;
  const offerAccess = connected || browserAuthRequired();

  return (
    <>
      {offerAccess && (
        <BrowserAccessButton
          connected={connected}
          onClick={() => {
            if (connected) {
              // Only this tab's key: GitHub and connector sign-ins stay.
              clearBrowserApiKey();
              reload();
            } else {
              setError(null);
              setOpen(true);
            }
          }}
        />
      )}
      <BrowserAuthDialog
        open={open}
        busy={busy}
        error={error}
        onConnect={(key) => void connect(key)}
        onCancel={() => {
          setError(null);
          setOpen(false);
        }}
      />
    </>
  );
}
