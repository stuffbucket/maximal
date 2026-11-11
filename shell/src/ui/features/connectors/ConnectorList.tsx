import type { MutableRefObject } from "react";

import { t } from "../../../i18n";
import type { PluginView } from "../../../proxy/client";

import { CLIENT_NAMES, standaloneClient } from "./clients";
import { listStatus, typeLabel } from "./connector-state";
import { CheckGlyph, ChevronGlyph, ConnectorTile, NoticeGlyph } from "./glyphs";

interface ConnectorListProps {
  connectors: Array<PluginView>;
  onOpen: (id: string) => void;
  /** Each row's button, so focus can come back to it from the detail page. */
  rowRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
}

/**
 * "Your connectors": one row per connector — name, type, status. The name is
 * the row's button (Tab stop, Enter opens); a click anywhere on the row opens
 * it too. Status is a tick when it's ready, else a tone dot and a word.
 */
export function ConnectorList({ connectors, onOpen, rowRefs }: ConnectorListProps): JSX.Element {
  return (
    <table className="table connector-table">
      <caption className="sr-only">{t("connectors-list-caption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("connectors-col-connector")}</th>
          <th scope="col">{t("connectors-col-type")}</th>
          <th scope="col">{t("connectors-col-status")}</th>
        </tr>
      </thead>
      <tbody>
        {connectors.map((connector) => {
          const status = listStatus(connector);
          const standalone = standaloneClient(connector);
          const notice =
            standalone && t("connectors-standalone-mark", { client: CLIENT_NAMES[standalone.id] });
          return (
            // The row's button is the keyboard path; the row click is a
            // larger target for the pointer.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
            <tr key={connector.id} className="connector-row" onClick={() => onOpen(connector.id)}>
              <td>
                <button
                  type="button"
                  className="connector-row__open"
                  ref={(el) => {
                    if (el) rowRefs.current.set(connector.id, el);
                    else rowRefs.current.delete(connector.id);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(connector.id);
                  }}
                >
                  <ConnectorTile />
                  <span className="connector-row__name">{connector.displayName}</span>
                  {notice && (
                    <span className="connector-notice__mark" role="img" aria-label={notice} title={notice}>
                      <NoticeGlyph />
                    </span>
                  )}
                </button>
              </td>
              <td className="connector-row__type">{typeLabel(connector)}</td>
              <td>
                <span className="connector-row__status">
                  {status.kind === "ready" ? (
                    <span className="connector-row__ok" role="img" aria-label={status.label} title={status.label}>
                      <CheckGlyph />
                    </span>
                  ) : (
                    <>
                      <span className={`connector-dot connector-dot--${status.tone}`} aria-hidden="true" />
                      <span>{status.label}</span>
                    </>
                  )}
                  <span className="connector-row__chevron" aria-hidden="true">
                    <ChevronGlyph />
                  </span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
