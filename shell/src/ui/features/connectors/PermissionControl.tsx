import { type KeyboardEvent, useRef } from "react";

import { t } from "../../../i18n";
import type { ToolPermission } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { AllowGlyph, AskGlyph, BlockGlyph } from "./glyphs";

const OPTIONS: ReadonlyArray<ToolPermission> = ["allow", "ask", "block"];

function optionLabel(value: ToolPermission): string {
  switch (value) {
    case "allow":
      return t("connectors-tool-allowed");
    case "ask":
      return t("connectors-tool-asks");
    case "block":
      return t("connectors-tool-blocked");
  }
}

function optionTip(value: ToolPermission): string {
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
  /** The tool's display title, for the group's accessible name. */
  tool: string;
  value: ToolPermission;
  onChange: (next: ToolPermission) => void;
  disabled?: boolean;
}

/**
 * Segmented control for one tool: Allowed / Asks / Blocked. A radio
 * group with a roving tab stop: Tab lands on the chosen option, arrow keys
 * move and choose (as native radios do), Home/End jump to either end.
 * Glyph-only, so each option carries its name and a tooltip.
 */
export function PermissionControl({ tool, value, onChange, disabled = false }: PermissionControlProps): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const choose = (index: number): void => {
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
      aria-label={t("connectors-tool-perm-aria", { tool })}
      aria-disabled={disabled || undefined}
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
            aria-label={optionLabel(option)}
            title={optionTip(option)}
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
