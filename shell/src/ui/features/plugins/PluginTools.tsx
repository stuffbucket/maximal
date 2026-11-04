import { t } from "../../../i18n";
import type { PluginToolSummary } from "../../../proxy/client";

interface PluginToolsProps {
  tools: Array<PluginToolSummary>;
}

/**
 * The tools a plugin offers, folded away until asked for: name and
 * description, plus a quiet badge when the plugin says a tool only reads or
 * can change things.
 */
export function PluginTools({ tools }: PluginToolsProps): JSX.Element {
  return (
    <details className="plugin-tools">
      <summary className="plugin-tools__summary">
        {t("plugins-tools-summary", { count: tools.length })}
      </summary>
      <ul className="plugin-tools__list">
        {tools.map((tool) => (
          <li className="plugin-tools__item" key={tool.name}>
            <div className="plugin-tools__head">
              <code className="plugin-tools__name mono">{tool.name}</code>
              {tool.annotations?.readOnlyHint === true && (
                <span className="chip">{t("plugins-tool-read-only")}</span>
              )}
              {tool.annotations?.destructiveHint === true && (
                <span className="chip chip--danger">{t("plugins-tool-destructive")}</span>
              )}
            </div>
            {tool.description && (
              <p className="plugin-tools__desc">{tool.description}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
