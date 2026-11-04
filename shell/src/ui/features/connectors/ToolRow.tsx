import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginToolView, ToolPermission } from "../../../proxy/client";
import { cx } from "../../components/cx";

import { ConnectorText } from "./ConnectorText";
import { ChevronGlyph } from "./glyphs";
import { PermissionControl } from "./PermissionControl";
import { inputsSummary, toolInputs, toolTitle } from "./tools";

interface ToolRowProps {
  tool: PluginToolView;
  onPermission: (next: ToolPermission) => void;
}

/**
 * One tool: its title and permission control, its description clamped to two
 * lines (Show more when it doesn't fit), then two twirldowns — its inputs
 * (name, type, required, description) and, nested, the whole input schema as
 * the connector sent it.
 */
export function ToolRow({ tool, onPermission }: ToolRowProps): JSX.Element {
  const title = toolTitle(tool);
  const inputs = useMemo(() => toolInputs(tool.inputSchema), [tool.inputSchema]);
  const schemaText = useMemo(() => JSON.stringify(tool.inputSchema, null, 2), [tool.inputSchema]);

  const [expanded, setExpanded] = useState(false);
  const [clamps, setClamps] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const descRef = useRef<HTMLParagraphElement | null>(null);
  const descId = useId();
  const inputsId = useId();
  const schemaId = useId();

  // "Show more" only when the clamp actually hides something; re-measured as
  // the window (and so the line length) changes.
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el || expanded) return;
    const measure = (): void => setClamps(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, tool.description]);

  return (
    <li className="tool">
      <div className="tool__head">
        <p className="tool__title">{title}</p>
        <PermissionControl tool={title} value={tool.permission} onChange={onPermission} />
      </div>

      {tool.description && (
        <>
          <p
            ref={descRef}
            id={descId}
            className={cx("tool__desc", !expanded && "tool__desc--clamped")}
          >
            <ConnectorText text={tool.description} />
          </p>
          {(clamps || expanded) && (
            <button
              type="button"
              className="tool__more"
              aria-expanded={expanded}
              aria-controls={descId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? t("connectors-tool-show-less") : t("connectors-tool-show-more")}
            </button>
          )}
        </>
      )}

      <div className="tool__twirls">
        {inputs.length > 0 && (
          <>
            <button
              type="button"
              className="twirl"
              aria-expanded={inputsOpen}
              aria-controls={inputsId}
              onClick={() => setInputsOpen((open) => !open)}
            >
              <ChevronGlyph className="twirl__chevron" />
              <span>{inputsOpen ? t("connectors-tool-hide-inputs") : inputsSummary(inputs)}</span>
            </button>
            <ul className="tool__inputs" id={inputsId} hidden={!inputsOpen}>
              {inputs.map((input) => (
                <li className="tool__input" key={input.name}>
                  <code className="tool__input-name mono">{input.name}</code>
                  {input.type && <code className="tool__input-type mono">{input.type}</code>}
                  {input.required && (
                    <span className="tool__input-required">{t("connectors-tool-required")}</span>
                  )}
                  {input.description && (
                    <span className="tool__input-desc">{input.description}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className={cx("tool__schema-wrap", inputs.length > 0 && "tool__schema-wrap--nested")}>
          <button
            type="button"
            className="twirl"
            aria-expanded={schemaOpen}
            aria-controls={schemaId}
            onClick={() => setSchemaOpen((open) => !open)}
          >
            <ChevronGlyph className="twirl__chevron" />
            <span>{t("connectors-tool-schema")}</span>
          </button>
          {/* Scrolls on its own, so it takes focus for keyboard scrolling. */}
          <pre
            className="tool__schema mono"
            id={schemaId}
            hidden={!schemaOpen}
            tabIndex={0}
            aria-label={t("connectors-tool-schema-aria", { tool: title })}
          >
            {schemaText}
          </pre>
        </div>
      </div>
    </li>
  );
}
