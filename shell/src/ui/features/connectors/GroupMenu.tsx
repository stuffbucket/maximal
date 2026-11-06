import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { ToolPermission } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { AllowGlyph, AskGlyph, BlockGlyph, CheckGlyph, ChevronDownGlyph, MixedGlyph } from "./glyphs";
import type { GroupPermission } from "./tools";

interface Item {
  value: GroupPermission;
  label: string;
  glyph: JSX.Element;
}

function items(): Array<Item> {
  return [
    { value: "allow", label: t("connectors-perm-allow"), glyph: <AllowGlyph /> },
    { value: "ask", label: t("connectors-perm-ask"), glyph: <AskGlyph /> },
    { value: "block", label: t("connectors-perm-block"), glyph: <BlockGlyph /> },
    { value: "custom", label: t("connectors-perm-custom"), glyph: <MixedGlyph /> },
  ];
}

interface GroupMenuProps {
  /** The group's name, e.g. "Read-only tools". */
  group: string;
  value: GroupPermission;
  onChange: (next: ToolPermission) => void;
  disabled?: boolean;
}

/**
 * The group's permission as a menu button: Always allow / Ask every time /
 * Blocked set every
 * tool in the group; Custom marks a mixed group (checked, never an action).
 * Arrow keys move, Enter/Space choose, Escape closes and returns focus to
 * the button, Tab or a click elsewhere closes.
 */
export function GroupMenu({ group, value, onChange, disabled = false }: GroupMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const list = items();
  const current = list.find((item) => item.value === value) ?? list[0];

  const openAt = (index: number): void => {
    setActive(index);
    setOpen(true);
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  // A press anywhere outside closes it, without stealing that press.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (item: Item): void => {
    if (item.value === "custom") return;
    close(true);
    if (item.value !== value) onChange(item.value);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openAt(event.key === "ArrowDown" ? 0 : list.length - 1);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const move = (index: number): void => setActive((index + list.length) % list.length);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(active + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(active - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(list.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        pick(list[active]);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div className="group-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--ghost btn--sm group-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("connectors-group-menu-aria", { group, value: current.label })}
        disabled={disabled}
        onClick={() => (open ? close(false) : openAt(Math.max(0, list.indexOf(current))))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="group-menu__glyph">{current.glyph}</span>
        {current.label}
        <span className="group-menu__chevron">
          <ChevronDownGlyph />
        </span>
      </button>
      {open && (
        <ul
          className="group-menu__list"
          id={menuId}
          role="menu"
          aria-label={t("connectors-group-menu-label", { group })}
          onKeyDown={onMenuKeyDown}
        >
          {list.map((item, index) => {
            const checked = item.value === value;
            const inert = item.value === "custom";
            return (
              <li
                key={item.value}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                role="menuitemradio"
                aria-checked={checked}
                aria-disabled={inert || undefined}
                tabIndex={index === active ? 0 : -1}
                className={cx("group-menu__item", inert && "group-menu__item--inert")}
                onClick={() => pick(item)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="group-menu__glyph">{item.glyph}</span>
                <span className="group-menu__label">{item.label}</span>
                <span className="group-menu__check">{checked && <CheckGlyph />}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
