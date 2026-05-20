import { Checkbox } from "../../ui/Checkbox";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";
import type { MutationResult } from "./useApiKeys";

interface WildcardSettingProps {
  entry: ApiKeyEntry | null;
  create: (input: {
    label: string;
    key?: string;
    enabled?: boolean;
  }) => Promise<MutationResult>;
  update: (
    id: string,
    patch: { label?: string; key?: string; enabled?: boolean },
  ) => Promise<MutationResult>;
}

/**
 * Wildcard as a setting, not a table row.
 *
 * The wildcard `*` is a different shape of entity from user-created
 * keys (one-of-a-kind, can't be deleted, exists implicitly until first
 * toggle). Forcing it into a row of the same table made:
 *   - the wildcard's `*` look like an editable input
 *   - the select-keys mode have to special-case its checkbox
 *   - the row chrome inconsistent
 *
 * Pulling it out as a labeled toggle (Apple System Settings pattern,
 * cf. "Allow handoff" / "AirDrop receive everyone") makes its
 * specialness visible and removes three branches of conditional
 * rendering from the table.
 *
 * Lazy-create stays the same as before — no `*` entry exists until
 * the user toggles. After that, toggling PATCHes the existing row.
 */
export function WildcardSetting({
  entry,
  create,
  update,
}: WildcardSettingProps): JSX.Element {
  const checked = entry ? entry.enabled : false;
  const onToggle = (next: boolean): void => {
    if (entry) {
      void update(entry.id, { enabled: next });
    } else {
      void create({ label: "Allow all", key: "*", enabled: next });
    }
  };

  return (
    <div className="wildcard-setting">
      <div className="wildcard-setting__row">
        <div className="wildcard-setting__label">
          <span className="wildcard-setting__title">Allow all API keys</span>
          <span className="wildcard-setting__hint">
            When on, any non-empty key passes auth. Useful for local
            setups; switch off and add named keys below before
            sharing the proxy.
          </span>
        </div>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label="Allow all API keys"
        />
      </div>
    </div>
  );
}
