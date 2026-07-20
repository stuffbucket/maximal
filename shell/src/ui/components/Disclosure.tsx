// vendored: wraps the `<details className="advanced-section">` +
// `<summary className="advanced-section__summary">` + `advanced-section__body`
// pattern duplicated in AdvancedSection.tsx and Models.tsx. Reuses those
// existing classes.
import type { ReactElement, ReactNode } from "react"

import { cx } from "./cx"

interface DisclosureProps {
  /** Content of the `<summary>` (a title node, count, etc.). */
  summary: ReactNode
  /** Whether the section is expanded on first render. */
  open?: boolean
  className?: string
  children: ReactNode
}

export function Disclosure({
  summary,
  open,
  className,
  children,
}: DisclosureProps): ReactElement {
  return (
    <details className={cx("advanced-section", className)} open={open}>
      <summary className="advanced-section__summary">{summary}</summary>
      <div className="advanced-section__body">{children}</div>
    </details>
  )
}
