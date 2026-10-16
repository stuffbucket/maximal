import { useId, useState } from "react";

import { cx } from "./cx";

interface LinkCheckboxProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Visible label. It's a link to `href`, not the checkbox's click target. */
  label: string;
  href: string;
  /** The checkbox's accessible name, e.g. "Add Work IQ to Claude Desktop". */
  checkboxLabel: string;
  disabled?: boolean;
  /** Why this target can't be chosen right now. Replaces the checkbox with
   *  a warning glyph in the same spot (a box would mean nothing here); the
   *  text shows on hover or focus. The label link still works. */
  unavailable?: string;
}

/**
 * A checkbox for a target that lives elsewhere in Settings: ticking the box
 * chooses it, and the label goes to where it's managed. When the target
 * can't be chosen, a warning glyph stands where the box would be and says
 * why. Clicking the label never toggles the box — it always navigates.
 */
export function LinkCheckbox({
  checked,
  onCheckedChange,
  label,
  href,
  checkboxLabel,
  disabled = false,
  unavailable,
}: LinkCheckboxProps): JSX.Element {
  const tipId = useId();
  // Escape hides the tooltip until the pointer/focus leaves (WCAG 1.4.13).
  const [dismissed, setDismissed] = useState(false);

  return (
    <span className={cx("link-check", unavailable && "link-check--unavailable")}>
      {unavailable ? (
        <span
          className={cx("link-check__warn", dismissed && "link-check__warn--dismissed")}
          role="img"
          tabIndex={0}
          aria-label={`${label} unavailable`}
          aria-describedby={tipId}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDismissed(true);
          }}
          onMouseLeave={() => setDismissed(false)}
          onBlur={() => setDismissed(false)}
        >
          <WarningIcon />
          <span className="tooltip" role="tooltip" id={tipId}>
            {unavailable}
          </span>
        </span>
      ) : (
        <input
          type="checkbox"
          className="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={checkboxLabel}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
      )}
      <a className="link-check__label" href={href}>
        {label}
      </a>
    </span>
  );
}

function WarningIcon(): JSX.Element {
  // lucide: triangle-alert
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
