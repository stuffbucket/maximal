import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginClientId, PluginClientView } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { CLIENT_NAMES } from "./clients";
import { CheckGlyph, ChevronDownGlyph, NoticeGlyph } from "./glyphs";

interface ClientMenuProps {
  connector: string;
  clients: Array<PluginClientView>;
  selected: ReadonlySet<PluginClientId>;
  disabled?: boolean;
  onChange: (id: PluginClientId, selected: boolean) => void;
}

/**
 * A checkbox dropdown for choosing which apps receive a connector. Unlike a
 * single-choice menu, checking an app keeps the menu open so several choices
 * can be changed in one pass.
 */
export function ClientMenu({
  connector,
  clients,
  selected,
  disabled = false,
  onChange,
}: ClientMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const chosenNames = clients
    .filter((client) => selected.has(client.id))
    .map((client) => CLIENT_NAMES[client.id]);
  const summary =
    chosenNames.length > 0
      ? chosenNames.join(", ")
      : t("connectors-client-legend", { connector });

  const openAt = (index: number): void => {
    setActive(index);
    setOpen(true);
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

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

  const toggle = (index: number): void => {
    const client = clients[index];
    if (disabled || !client?.available) return;
    onChange(client.id, !selected.has(client.id));
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openAt(event.key === "ArrowDown" ? 0 : clients.length - 1);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const move = (index: number): void => setActive((index + clients.length) % clients.length);
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
        move(clients.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        toggle(active);
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
    <div className="group-menu client-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--secondary client-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("connectors-client-legend", { connector })}
        disabled={disabled}
        onClick={() => {
          if (open) close(false);
          else openAt(Math.max(0, clients.findIndex((client) => selected.has(client.id))));
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="client-menu__summary">{summary}</span>
        <span className="group-menu__chevron">
          <ChevronDownGlyph />
        </span>
      </button>
      {open && (
        <ul
          className="group-menu__list client-menu__list"
          id={menuId}
          role="menu"
          aria-label={t("connectors-client-legend", { connector })}
          onKeyDown={onMenuKeyDown}
        >
          {clients.map((client, index) => {
            const checked = selected.has(client.id);
            const reasonId = `${menuId}-${client.id}-reason`;
            return (
              <li
                key={client.id}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                role="menuitemcheckbox"
                aria-label={CLIENT_NAMES[client.id]}
                aria-checked={checked}
                aria-disabled={disabled || !client.available || undefined}
                aria-describedby={client.reason ? reasonId : undefined}
                tabIndex={index === active ? 0 : -1}
                className={cx(
                  "group-menu__item",
                  (disabled || !client.available) && "group-menu__item--inert",
                )}
                title={client.reason}
                onClick={() => toggle(index)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="group-menu__check client-menu__check">
                  {checked && <CheckGlyph />}
                </span>
                <span className="group-menu__label">{CLIENT_NAMES[client.id]}</span>
                {!client.available && (
                  <span className="client-menu__warning">
                    <NoticeGlyph />
                  </span>
                )}
                {client.reason && (
                  <span className="sr-only" id={reasonId}>
                    {client.reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
