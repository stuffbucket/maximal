import { Checkbox } from "../../ui/Checkbox";
import { Tr, Td } from "../../ui/Table";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";
import { SelectCell } from "./SelectCell";
import type { MutationResult } from "./useApiKeys";

interface WildcardRowProps {
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
 * Pinned, non-deletable wildcard row. Two states for the Enabled
 * checkbox:
 *
 *  1) An explicit `*` entry exists in config — Enabled reflects its
 *     real `enabled` field; toggling PATCHes.
 *  2) No `*` entry yet — Enabled defaults to checked (`[x]`) but we
 *     deliberately do NOT POST on initial render. ADR-0002's lazy-
 *     create choice: only persist when the user actively toggles.
 *
 * Wildcard cannot be deleted; the SelectCell renders empty in select
 * mode (no disabled-but-visible checkbox — that's bug 1 from the
 * previous design pass).
 *
 * The `*` itself is rendered as plain mono text. We don't use
 * `.api-keys__key-text` chrome here because the wildcard isn't a
 * masked, copy-on-click secret — it's a literal config value.
 */
export function WildcardRow({
  entry,
  selectMode,
  create,
  update,
}: WildcardRowProps): JSX.Element {
  const checked = entry ? entry.enabled : true;

  const onToggle = (next: boolean): void => {
    if (entry) {
      void update(entry.id, { enabled: next });
    } else {
      // Lazy materialization: no `*` entry exists yet. On the first
      // intentional toggle (either direction), persist so the proxy
      // has a row to enforce against on subsequent boots.
      void create({ label: "Allow all", key: "*", enabled: next });
    }
  };

  return (
    <Tr className="api-keys__row--wildcard">
      <SelectCell selectMode={selectMode} selectable={false} />
      <Td>
        <code className="mono api-keys__wildcard-glyph">*</code>
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
