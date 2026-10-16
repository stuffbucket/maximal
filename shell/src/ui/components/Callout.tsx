import type { ReactNode } from "react";

import { cx } from "./cx";

type CalloutTone = "error" | "notice";

interface CalloutProps {
  /** error: something failed (destructive stripe). notice: worth knowing, not wrong. */
  tone: CalloutTone;
  title?: string;
  children?: ReactNode;
  /** One action that resolves it, e.g. a "Try again" button. */
  action?: ReactNode;
  className?: string;
}

/**
 * A full-width banner across the top of a section or card: stripe + icon +
 * a title saying what happened + the detail + at most one remedy. The
 * shared form of the requirement-callout / conflict idiom, for any state
 * that would otherwise be a bare line of colored text.
 */
export function Callout({ tone, title, children, action, className }: CalloutProps): JSX.Element {
  return (
    <div
      className={cx("callout", `callout--${tone}`, className)}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="callout__icon" aria-hidden="true">
        {tone === "error" ? <AlertIcon /> : <InfoIcon />}
      </span>
      <div className="callout__text">
        {title && <p className="callout__title">{title}</p>}
        {children && <div className="callout__detail">{children}</div>}
      </div>
      {action && <div className="callout__action">{action}</div>}
    </div>
  );
}

function AlertIcon(): JSX.Element {
  // lucide: triangle-alert
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function InfoIcon(): JSX.Element {
  // lucide: info
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
