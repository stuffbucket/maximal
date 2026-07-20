// vendored: wraps the repeated error-banner markup
// (`.state__caption .state__caption--error` with `role="alert"`) used at
// ApiClients, AppsPanel, AddConnection, and Models.
import type { ReactElement, ReactNode } from "react"

import { cx } from "./cx"

/** Visual tone. Only "error" exists today; typed as a union to leave room. */
type AlertTone = "error"

interface AlertProps {
  tone?: AlertTone
  className?: string
  children: ReactNode
}

const TONE_CLASS: Record<AlertTone, string> = {
  error: "state__caption state__caption--error",
}

export function Alert({
  tone = "error",
  className,
  children,
}: AlertProps): ReactElement {
  return (
    <p className={cx(TONE_CLASS[tone], className)} role="alert">
      {children}
    </p>
  )
}
