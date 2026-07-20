// vendored: controlled toggle wrapping the .switch checkbox in styles.css.
import type { ReactElement, InputHTMLAttributes } from "react"

import { cx } from "./cx"

interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange"
> {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: string
  hideLabel?: boolean
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  hideLabel,
  className,
  ...rest
}: SwitchProps): ReactElement {
  return (
    <label className={cx("switch", className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        {...rest}
      />
      {label !== undefined && (
        <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      )}
    </label>
  )
}
