import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import { t } from "../../i18n";
import {
  onBrowserAuthRequired,
  isNativeShell,
  browserApiKey,
  browserAuthRequired,
  clearBrowserApiKey,
  saveBrowserApiKey,
} from "../../proxy/browser-auth";
import { apiCall } from "../../proxy/client";
import { Callout } from "../components/Callout";
import { ModalDialog } from "../components/ModalDialog";

function BrowserAuth(): JSX.Element {
  const [open, setOpen] = useState(browserAuthRequired);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    const requireAccess = (): void => {
      setKey("");
      setError("");
      setOpen(true);
    };
    const unsubscribe = onBrowserAuthRequired(requireAccess);
    // API calls can finish before React's first effect subscribes.
    if (browserAuthRequired()) requireAccess();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (error && !busy) inputRef.current?.focus();
  }, [error, busy]);

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true);
    setError("");
    const result = await apiCall({
      kind: "auth-status",
      method: "GET",
      path: "/settings/api/auth/github/status",
    }, { apiKey: key.trim() });
    if (!result.ok) {
      setError(t(result.authRequired ? "browser-auth-invalid" : "browser-auth-unavailable"));
      setBusy(false);
      return;
    }
    try {
      saveBrowserApiKey(key);
    } catch {
      setError(t("browser-auth-storage"));
      setBusy(false);
      return;
    }
    setKey("");
    // Fresh reads rebuild every island and event stream. Never replay a mutation.
    window.location.reload();
  };

  return (
    <>
      {(browserApiKey() || browserAuthRequired()) && !open && (
        <button className="btn btn--ghost btn--sm" type="button" onClick={() => {
          if (browserApiKey()) {
            clearBrowserApiKey();
            window.location.reload();
          } else {
            setError("");
            setOpen(true);
          }
        }}>
          {t(browserApiKey() ? "browser-auth-disconnect" : "browser-auth-connect")}
        </button>
      )}
      <ModalDialog open={open} className="confirm-dialog" ariaLabelledBy={titleId}
        initialFocusRef={inputRef} onDismiss={() => { if (!busy) { setKey(""); setError(""); setOpen(false); } }}>
        <form className="confirm-dialog__panel browser-auth" onSubmit={(event) => { void connect(event); }}>
          <h2 className="confirm-dialog__title" id={titleId}>{t("browser-auth-title")}</h2>
          <p className="confirm-dialog__body">{t("browser-auth-description")}</p>
          <p className="confirm-dialog__body">{t("browser-auth-command")} <code>maximal api claude-code</code></p>
          <label htmlFor={inputId}>{t("browser-auth-key")}</label>
          <input ref={inputRef} id={inputId} className="input" type="password" required
            autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} value={key} disabled={busy}
            onChange={(event) => setKey(event.target.value)} />
          {error && <Callout tone="error">{error}</Callout>}
          <div className="confirm-dialog__actions">
            <button type="button" className="btn btn--ghost" disabled={busy}
              onClick={() => { setKey(""); setError(""); setOpen(false); }}>{t("common-cancel")}</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !key.trim()}>
              {t(busy ? "browser-auth-connecting" : "browser-auth-connect")}
            </button>
          </div>
        </form>
      </ModalDialog>
    </>
  );
}

export function mountBrowserAuth(): void {
  const root = document.getElementById("browser-auth-root");
  if (!root) return;
  if (isNativeShell()) {
    root.hidden = true;
    return;
  }
  createRoot(root).render(<BrowserAuth />);
}
