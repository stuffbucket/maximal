import { Checkbox } from "../../ui/Checkbox";
import { Tr, Td } from "../../ui/Table";
import { cx } from "../../ui/cx";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";
import type { MutationResult } from "./useApiKeys";

export interface WildcardRowProps {
  entry: ApiKeyEntry | null;
  selectMode: boolean;
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
 * Pinned, non-deletable wildcard row. Two states:
 *
 *  1) An explicit `*` entry exists in config — Enabled checkbox
 *     reflects its real `enabled` field; toggling PATCHes.
 *  2) No `*` entry yet — Enabled defaults to checked (`[x]`), but we
 *     deliberately do NOT POST on initial render. This is the lazy-
 *     create choice from ADR-0002 ("pick the lazier creation path;
 *     render `[x]` by default; POST only on intentional change").
 *     The user has to actively toggle for any write to happen.
 *
 * The wildcard can never be deleted — its Select checkbox is always
 * disabled. The Show/Hide affordance on `*` has nothing to mask, so
 * we render a disabled em-dash placeholder.
 */
export function WildcardRow({
  entry,
  selectMode,
  create,
  update,
}: WildcardRowProps): JSX.Element {
  // ADR-0002 lazy-create: when no wildcard entry exists we still SHOW
  // `[x]` (the proxy accepts all local requests in that mode), so the
  // visual reflects the effective state. The first toggle commits to
  // the persistence store.
  const checked = entry ? entry.enabled : true;

  const onToggle = (next: boolean): void => {
    if (entry) {
      void update(entry.id, { enabled: next });
    } else if (next) {
      // Toggling on when no entry exists — wildcard is already
      // effectively allow-all, but the user clicked, so persist.
      void create({ label: "Allow all", key: "*", enabled: true });
    } else {
      // Toggling off with no entry — we must materialize a disabled
      // entry so the proxy starts enforcing. POST with enabled:false.
      void create({ label: "Allow all", key: "*", enabled: false });
    }
  };

  return (
    <Tr className="api-keys__row--wildcard">
      <Td
        className={cx(
          "api-keys__select-col",
          !selectMode && "api-keys__select-col--hidden",
        )}
      >
        {/* Wildcard cannot be deleted — checkbox is rendered but disabled. */}
        <Checkbox checked={false} onCheckedChange={() => {}} disabled aria-label="Wildcard cannot be selected" />
      </Td>
      <Td>
        <div className="api-keys__cell-key">
          <span className="api-keys__key-text mono">*</span>
          {/* Nothing to mask on a single-char key. Render disabled em-dash. */}
          <button type="button" className="btn btn--ghost btn--sm" disabled>
            —
          </button>
        </div>
      </Td>
      <Td className="api-keys__label">Allow all API keys</Td>
      <Td>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label="Enable wildcard"
        />
      </Td>
    </Tr>
  );
}
