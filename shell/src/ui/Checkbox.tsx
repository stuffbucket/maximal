// vendored: controlled native checkbox with disabled support.
import type { InputHTMLAttributes } from "react";

interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange"> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: string;
  hideLabel?: boolean;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hideLabel = true,
  ...rest
}: CheckboxProps): JSX.Element {
  const input = (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      {...rest}
    />
  );
  if (label === undefined) return input;
  return (
    <label>
      {input}
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </label>
  );
}
