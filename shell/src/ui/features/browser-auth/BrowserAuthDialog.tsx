import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { t } from "../../../i18n";
import { Callout } from "../../components/Callout";
import { ModalDialog } from "../../components/ModalDialog";

/** Why the last attempt didn't connect. */
export type BrowserAuthError =
  /** Maximal refused the key: a caption under the field. */
  | "invalid"
  /** Maximal couldn't check it (not answering, or another error). */
  | "unavailable"
  /** The browser refused session storage, so the key can't be kept. */
  | "storage";

/** The command that prints an existing key on the machine running Maximal. */
export const BROWSER_AUTH_COMMAND = "maximal api claude-code";

interface BrowserAuthDialogProps {
  open: boolean;
  /** Checking a key: the field and buttons are disabled. */
  busy: boolean;
  error: BrowserAuthError | null;
  onConnect: (key: string) => void;
  onCancel: () => void;
}

/**
 * "Connect this browser to Maximal": asks a plain browser for an existing
 * Maximal API key. A refused key is a caption under its field (validation);
 * anything else that stopped it is an error callout above the actions.
 */
export function BrowserAuthDialog({
  open,
  busy,
  error,
  onConnect,
  onCancel,
}: BrowserAuthDialogProps): JSX.Element {
  const [key, setKey] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();

  // A fresh prompt never shows the last key typed.
  useEffect(() => {
    if (!open) setKey("");
  }, [open]);

  // After a failed attempt the field is where the fix happens.
  useEffect(() => {
    if (error && !busy) inputRef.current?.focus();
  }, [error, busy]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = key.trim();
    if (busy || !trimmed) return;
    onConnect(trimmed);
  };

  const invalid = error === "invalid";
  const dismiss = (): void => {
    if (!busy) onCancel();
  };

  return (
    <ModalDialog
      open={open}
      className="confirm-dialog browser-auth"
      ariaLabelledBy={titleId}
      initialFocusRef={inputRef}
      onDismiss={dismiss}
    >
      <form className="confirm-dialog__panel" onSubmit={submit}>
        <h2 className="confirm-dialog__title" id={titleId}>
          {t("browser-auth-title")}
        </h2>
        <div className="confirm-dialog__body">
          <p>{t("browser-auth-description")}</p>
          <p>{t("browser-auth-command")}</p>
          <p>
            <code>{BROWSER_AUTH_COMMAND}</code>
          </p>
        </div>
        <div className="browser-auth__field">
          <label htmlFor={inputId}>{t("browser-auth-key")}</label>
          <input
            ref={inputRef}
            id={inputId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            required
            value={key}
            disabled={busy}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => setKey(event.target.value)}
          />
          {invalid && (
            <p className="browser-auth__error" id={errorId} role="alert">
              {t("browser-auth-invalid")}
            </p>
          )}
        </div>
        {error === "unavailable" && (
          <Callout tone="error">{t("browser-auth-unavailable")}</Callout>
        )}
        {error === "storage" && (
          <Callout tone="error">{t("browser-auth-storage")}</Callout>
        )}
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={dismiss}
          >
            {t("common-cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !key.trim()}
          >
            {t(busy ? "browser-auth-connecting" : "browser-auth-connect")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

interface BrowserAccessButtonProps {
  /** Connected: offers Disconnect. Otherwise offers Connect. */
  connected: boolean;
  onClick: () => void;
}

/**
 * The title bar's browser-access control: a ghost icon like the update icon,
 * so it never takes width from the Settings tabs. Named by aria-label and a
 * quiet tooltip.
 */
export function BrowserAccessButton({
  connected,
  onClick,
}: BrowserAccessButtonProps): JSX.Element {
  const label = t(
    connected ? "browser-auth-disconnect" : "browser-auth-connect",
  );
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-label={label}
      title={label}
      data-browser-access={connected ? "connected" : "required"}
      onClick={onClick}
    >
      {connected ? <UnplugIcon /> : <KeyIcon />}
    </button>
  );
}

function KeyIcon(): JSX.Element {
  // lucide: key-round
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

function UnplugIcon(): JSX.Element {
  // lucide: unplug
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m19 5 3-3" />
      <path d="m2 22 3-3" />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
      <path d="M7.5 13.5 10 11" />
      <path d="M10.5 16.5 13 14" />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
    </svg>
  );
}
