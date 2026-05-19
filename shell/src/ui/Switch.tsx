// vendored: controlled toggle wrapping the .switch checkbox in styles.css.
import { cx } from "./cx";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: string;
  hideLabel?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  hideLabel,
  disabled,
  id,
  className,
}: SwitchProps): JSX.Element {
  return (
    <label className={cx("switch", className)}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
      {label !== undefined && (
        <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      )}
    </label>
  );
}
