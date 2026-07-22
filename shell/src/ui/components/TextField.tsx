// vendored: wraps the label + `.input` + hint scaffold duplicated in
// AddConnection.tsx (`add-connection__field` / `__field-label` / `.input` /
// `__hint`) and the field label in ConnectionCard.tsx. Reuses those existing
// classes; label and input are associated via `htmlFor`/`id`.
import {
  type ReactElement,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react"

import { cx } from "./cx"

interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  label: ReactNode
  hint?: ReactNode
  type?: InputHTMLAttributes<HTMLInputElement>["type"]
}

export function TextField({
  label,
  hint,
  id,
  type = "text",
  className,
  ...rest
}: TextFieldProps): ReactElement {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <div className="add-connection__field">
      <label className="add-connection__field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        className={cx("input", className)}
        {...rest}
      />
      {hint !== undefined && (
        <span className="add-connection__hint">{hint}</span>
      )}
    </div>
  )
}
