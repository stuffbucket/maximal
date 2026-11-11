import { useId, useState } from "react";

import { t } from "../../../i18n";
import type { PluginDetailView, PluginToolView, ToolGroup, ToolPermission } from "../../../proxy/client";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import { ChevronGlyph } from "./glyphs";
import { GroupMenu } from "./GroupMenu";
import { ToolRow } from "./ToolRow";
import { GROUP_ORDER, groupLabel, groupPermission, relativeTime } from "./tools";
import type { ConnectorMutationResult } from "./useConnectors";

interface ToolPermissionsProps {
  connector: PluginDetailView;
  onChange: (changes: Record<string, ToolPermission>) => Promise<ConnectorMutationResult>;
}

/**
 * Tool permissions: the connector's tools in three collapsible groups
 * (read-only, write/delete, other), each with a count and a menu that sets
 * the whole group. Changes save as made and show at once; a failed save
 * puts the controls back and says why.
 */
export function ToolPermissions({ connector, onChange }: ToolPermissionsProps): JSX.Element {
  const [failed, setFailed] = useState<{ problem: Problem; changes: Record<string, ToolPermission> } | null>(null);

  const save = async (changes: Record<string, ToolPermission>): Promise<void> => {
    setFailed(null);
    const result = await onChange(changes);
    if (!result.ok && result.problem) setFailed({ problem: result.problem, changes });
  };

  const groups = GROUP_ORDER.map((group) => ({
    group,
    tools: connector.tools.filter((tool) => tool.group === group),
  })).filter(({ tools }) => tools.length > 0);

  return (
    <section className="connector-section" aria-labelledby={`${connector.id}-tools-title`}>
      <div className="connector-section__head">
        <h4 className="connector-section__title" id={`${connector.id}-tools-title`}>
          {t("connectors-tools-title")}
        </h4>
        <p className="connector-section__sub">{t("connectors-tools-sub")}</p>
      </div>

      {connector.toolsSource === "cache" && connector.catalogUpdatedAt && (
        <p className="panel-status">{cachedNote(connector, connector.catalogUpdatedAt)}</p>
      )}

      {failed && (
        <ProblemCallout problem={failed.problem} onRetry={() => void save(failed.changes)} />
      )}

      {groups.length === 0 ? (
        <p className="panel-status">{t("connectors-tools-none")}</p>
      ) : (
        groups.map(({ group, tools }) => (
          <ToolGroupBlock key={group} group={group} tools={tools} onChange={(changes) => void save(changes)} />
        ))
      )}
    </section>
  );
}

/** When the tools were last seen, and what would refresh them. */
function cachedNote(connector: PluginDetailView, seenAt: string): string {
  const when = relativeTime(seenAt);
  if (!connector.enabled) {
    return t("connectors-tools-cached-off", { when, connector: connector.displayName });
  }
  if (connector.lifecycle === "active") return t("connectors-tools-cached", { when });
  return t("connectors-tools-cached-plain", { when });
}

interface ToolGroupBlockProps {
  group: ToolGroup;
  tools: Array<PluginToolView>;
  onChange: (changes: Record<string, ToolPermission>) => void;
}

function ToolGroupBlock({ group, tools, onChange }: ToolGroupBlockProps): JSX.Element {
  const [open, setOpen] = useState(true);
  const listId = useId();
  const label = groupLabel(group);

  const setAll = (value: ToolPermission): void =>
    onChange(Object.fromEntries(tools.map((tool) => [tool.name, value])));

  return (
    <div className="tool-group">
      <div className="tool-group__head">
        <h5 className="tool-group__title">
          <button
            type="button"
            className="twirl tool-group__toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((prev) => !prev)}
          >
            <ChevronGlyph className="twirl__chevron" />
            <span>{label}</span>{" "}
            <span className="count-badge">{tools.length}</span>
          </button>
        </h5>
        <GroupMenu group={label} value={groupPermission(tools)} onChange={setAll} />
      </div>
      <ul className="tool-group__list" id={listId} hidden={!open}>
        {tools.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            onPermission={(value) => onChange({ [tool.name]: value })}
          />
        ))}
      </ul>
    </div>
  );
}
