import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginAccessView, ToolPermission } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { InformationGlyph } from "./glyphs";
import { PermissionControl } from "./PermissionControl";

interface AppPermissionsProps {
  targets: ReadonlyArray<PluginAccessView>;
  permissions: Readonly<Record<string, ToolPermission>>;
  /** A save is in flight: the controls stay focusable but ignore changes. */
  busy?: boolean;
  onChange: (id: string, permission: ToolPermission) => void;
}

interface AccessRowProps {
  target: PluginAccessView;
  permission: ToolPermission;
  busy: boolean;
  onChange: (permission: ToolPermission) => void;
}

function AccessInformation({ target }: { target: PluginAccessView }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  // A tap or click that lands elsewhere dismisses the card (touch browsers
  // don't always blur the button).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (target.available || !target.reason) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // Only an open card consumes Escape; otherwise it closes the dialog.
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  // Touch has no hover: the tap's click opens the card. Clicking never closes
  // it, so the click that follows a hover or focus can't undo it.
  const hover = (event: ReactPointerEvent<HTMLButtonElement>, next: boolean): void => {
    if (event.pointerType !== "touch") setOpen(next);
  };

  return (
    <span className="access-info" ref={rootRef}>
      <button
        type="button"
        className="access-info__trigger"
        aria-label={t("connectors-access-info-aria", { name: target.name })}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onPointerEnter={(event) => hover(event, true)}
        onPointerLeave={(event) => hover(event, false)}
        onKeyDown={onKeyDown}
      >
        <InformationGlyph />
      </button>
      {open && (
        <span className="access-info__card" id={tooltipId} role="tooltip">
          {target.reason}
        </span>
      )}
    </span>
  );
}

function AccessRow({ target, permission, busy, onChange }: AccessRowProps): JSX.Element {
  return (
    <li className={cx("access-row", !target.available && "access-row--unavailable")}>
      <div className="access-row__identity">
        <span className="access-row__name">{target.name}</span>
        <AccessInformation target={target} />
      </div>
      <PermissionControl
        label={t("connectors-access-perm-aria", { name: target.name })}
        value={permission}
        kind="access"
        busy={busy}
        onChange={onChange}
      />
    </li>
  );
}

/** Every app and named API connection that can reach this connector. */
export function AppPermissions({
  targets,
  permissions,
  busy = false,
  onChange,
}: AppPermissionsProps): JSX.Element {
  const apps = targets.filter((target) => target.kind === "app");
  const connections = targets.filter((target) => target.kind === "connection");

  const group = (title: string, items: ReadonlyArray<PluginAccessView>): JSX.Element | null =>
    items.length === 0 ? null : (
      <div className="access-group">
        <h5 className="access-group__title">{title}</h5>
        <ul className="access-list">
          {items.map((target) => (
            <AccessRow
              key={target.id}
              target={target}
              permission={permissions[target.id] ?? target.permission}
              busy={busy}
              onChange={(permission) => onChange(target.id, permission)}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <div className="app-permissions">
      <p className="connector-section__sub">{t("connectors-access-sub")}</p>
      {group(t("connectors-access-apps"), apps)}
      {group(t("connectors-access-connections"), connections)}
    </div>
  );
}
