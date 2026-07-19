import type { ReactElement } from "react"

import type { MutationResult } from "./useApiKeys"

import { Checkbox } from "../../components/Checkbox"

interface AdvancedSectionProps {
  enforcing: boolean
  setEnforce: (next: boolean) => Promise<MutationResult>
}

/**
 * Optional gate the user can turn on once they're done adding the
 * connections they trust. Off by default — the entry list is purely
 * for labeling traffic, not for blocking it, until the user decides
 * otherwise.
 */
export function AdvancedSection({
  enforcing,
  setEnforce,
}: AdvancedSectionProps): ReactElement {
  return (
    <details className="advanced-section">
      <summary className="advanced-section__summary">
        <span className="advanced-section__title">Advanced</span>
      </summary>
      <div className="advanced-section__body">
        <div className="advanced-section__row">
          <div className="advanced-section__label">
            <span className="advanced-section__row-title">
              Block unknown connections
            </span>
            <span className="advanced-section__row-hint">
              When on, apps that don't present one of the keys listed above are
              turned away. Leave off if you just want to see which app is which.
            </span>
          </div>
          <Checkbox
            checked={enforcing}
            onCheckedChange={(next) => void setEnforce(next)}
            aria-label="Block unknown connections"
          />
        </div>
      </div>
    </details>
  )
}
