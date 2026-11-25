import { type KeyboardEvent, useRef } from "react";

import { t } from "../../../i18n";
import type { ToolPermission } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { AllowGlyph, AskGlyph, BlockGlyph } from "./glyphs";

const OPTIONS: ReadonlyArray<ToolPermission> = ["allow", "ask", "block"];

type PermissionKind = "tool" | "access";

function optionLabel(value: ToolPermission, kind: PermissionKind): string {
  if (kind === "access") {
    switch (value) {
      case "allow":
        return t("connectors-access-allow");
      case "ask":
        return t("connectors-access-ask");
      case "block":
        return t("connectors-access-block");
    }
  }
  switch (value) {
    case "allow":
      return t("connectors-tool-allowed");
    case "ask":
      return t("connectors-tool-asks");
    case "block":
      return t("connectors-tool-blocked");
  }
}

function optionTip(value: ToolPermission, kind: PermissionKind): string {
  if (kind === "access") {
    switch (value) {
      case "allow":
        return t("connectors-access-allow-tip");
      case "ask":
        return t("connectors-access-ask-tip");
      case "block":
        return t("connectors-access-block-tip");
    }
  }
  switch (value) {
    case "allow":
      return t("connectors-tool-allowed-tip");
    case "ask":
      return t("connectors-tool-asks-tip");
    case "block":
      return t("connectors-tool-blocked-tip");
  }
}

function OptionGlyph({ value }: { value: ToolPermission }): JSX.Element {
  switch (value) {
    case "allow":
      return <AllowGlyph />;
    case "ask":
      return <AskGlyph />;
    case "block":
      return <BlockGlyph />;
  }
}

interface PermissionControlProps {
  /** Complete accessible name for the radio group. */
  label: string;
  value: ToolPermission;
  onChange: (next: ToolPermission) => void;
  kind?: PermissionKind;
  disabled?: boolean;
  /**
   * A save is in flight. The options stay focusable (so keyboard focus isn't
   * lost when the control re-renders) but are read-only until it settles.
   */
  busy?: boolean;
}

/**
 * Segmented Allow / Ask / Block control with a roving tab stop. Tab lands on
 * the chosen option; arrow keys move and choose, and Home/End jump to either
 * end. Glyph-only, so each option carries its own name and tooltip.
 */
export function PermissionControl({
  label,
  value,
  onChange,
  kind = "tool",
  disabled = false,
  busy = false,
}: PermissionControlProps): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const choose = (index: number): void => {
    if (busy) return;
    const next = OPTIONS[(index + OPTIONS.length) % OPTIONS.length];
    refs.current[OPTIONS.indexOf(next)]?.focus();
    if (next !== value) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        choose(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        choose(index - 1);
        break;
      case "Home":
        event.preventDefault();
        choose(0);
        break;
      case "End":
        event.preventDefault();
        choose(OPTIONS.length - 1);
        break;
    }
  };

  return (
    <div
      className="perm-seg"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      aria-readonly={busy || undefined}
    >
      {OPTIONS.map((option, index) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={optionLabel(option, kind)}
            title={optionTip(option, kind)}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={cx("perm-seg__option", `perm-seg__option--${option}`)}
            onClick={() => choose(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <OptionGlyph value={option} />
          </button>
        );
      })}
    </div>
  );
}
