// vendored: borderless-by-default input for inline-edit table cells. forwardRef so the parent can focus().
import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "./cx";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  inline?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput({ inline, className, ...rest }, ref): JSX.Element {
    return (
      <input
        ref={ref}
        type="text"
        className={cx(inline ? "input--inline" : "input", className)}
        {...rest}
      />
    );
  },
);
