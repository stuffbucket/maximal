// vendored: controlled native checkbox with a custom-styled appearance.
//
// Why custom: the bare native checkbox on a dark surface is nearly
// invisible (1px UA border on near-black is hard to see). `.switch`
// in styles.css already paints its native input via appearance: none
// + ::after thumb; this component takes the same approach so we
// don't have a "disabled wildcard checkbox visible / active user
// checkbox invisible" inversion. Wrapper class `.checkbox` defined
// in styles.css owns the visual; the input itself is the spread
// landing site for `disabled`, `aria-label`, `onKeyDown`, etc.
import type { ReactElement, InputHTMLAttributes } from "react"

interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange"
> {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: string
  hideLabel?: boolean
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hideLabel = true,
  className,
  ...rest
}: CheckboxProps): ReactElement {
  const input = (
    <input
      type="checkbox"
      className={["checkbox", className].filter(Boolean).join(" ")}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      {...rest}
    />
  )
  if (label === undefined) return input
  return (
    <label className="checkbox-label">
      {input}
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </label>
  )
}
