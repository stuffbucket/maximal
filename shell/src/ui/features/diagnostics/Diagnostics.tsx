import { type ReactElement, type ReactNode, useState } from "react"

import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "../../../../../src/lib/config/settings-types"

import { invokeCommand, openUrl, safeInvoke } from "../../../tauri/shell"
import { Button } from "../../components/Button"
import { Checkbox } from "../../components/Checkbox"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { Disclosure } from "../../components/Disclosure"
import { Stack } from "../../components/Stack"
import { useT } from "../../i18n/useT"
import {
  deriveGithubCopilotStatus,
  formatLaunchSource,
  formatRateLimit,
  formatUpdateHealth,
  formatUptime,
  formatWebSearch,
  type TranslateFn,
} from "./format"
import { useDiagnostics } from "./useDiagnostics"

/** A `<dl class="kv kv--bare">` row: a term and a value (mono by default). */
function Row({
  label,
  children,
  mono = true,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}): ReactElement {
  return (
    <div className="kv__row">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  )
}

/**
 * Render an ICU message with a single `{arg}` replaced by a real React node
 * (e.g. a `<code>`), so word order stays translatable instead of concatenated.
 * The vanilla side did this imperatively via `fillWithNode`.
 */
function fillNode(
  t: TranslateFn,
  key: string,
  arg: { name: string; node: ReactNode },
): ReactNode {
  const SENTINEL = "\uE000"
  const parts = t(key, { [arg.name]: SENTINEL }).split(SENTINEL)
  return parts.flatMap((part, i) =>
    i === 0 ? [part] : [<span key={i}>{arg.node}</span>, part],
  )
}

/** The "Updates" outcome value: a newer-release link, "up to date", or unknown. */
function UpdatesValue({
  t,
  status,
}: {
  t: TranslateFn
  status: UpdateStatusResponse | null
}): ReactElement {
  if (status?.update_available && status.latest) {
    const url = status.url
    return (
      <>
        <span className="mono">
          {t("diagnostics-update-newer", { version: status.latest })}
        </span>
        <a
          href={url}
          onClick={(e) => {
            e.preventDefault()
            // A browser tab can't invoke the updater plugin, so POST
            // /_internal/upgrade — the sidecar signals the shell (202 → it owns
            // it). Anything else falls back to the download page, never a dead
            // end.
            void fetch("/_internal/upgrade", { method: "POST" }).then(
              (res) => {
                if (res.status !== 202) void openUrl(url)
              },
              () => void openUrl(url),
            )
          }}
        >
          {t("diagnostics-update-get-it")}
        </a>
      </>
    )
  }
  return (
    <span className="mono">
      {status?.latest ?
        t("diagnostics-update-up-to-date")
      : t("diagnostics-update-unknown")}
    </span>
  )
}

/** The live-state definition list (proxy version, uptime, tokens, rate limit…). */
function InfoList({
  t,
  data,
  updateStatus,
}: {
  t: TranslateFn
  data: DiagnosticsResponse
  updateStatus: UpdateStatusResponse | null
}): ReactElement {
  return (
    <dl className="kv kv--bare">
      <Row label={t("diagnostics-proxy-version")}>{data.version}</Row>
      <Row label={t("diagnostics-updates")} mono={false}>
        <UpdatesValue t={t} status={updateStatus} />
      </Row>
      <Row label={t("diagnostics-update-check")}>
        {updateStatus ?
          formatUpdateHealth(t, updateStatus)
        : t("diagnostics-update-check-unavailable")}
      </Row>
      <Row label={t("diagnostics-git-sha")}>
        {data.source_revision ?? t("diagnostics-unknown")}
      </Row>
      <Row label={t("diagnostics-launched-from")}>
        {formatLaunchSource(t, data)}
      </Row>
      <Row label={t("diagnostics-sidecar-pid")}>{String(data.pid)}</Row>
      <Row label={t("diagnostics-uptime")}>
        {formatUptime(t, data.uptime_ms)}
      </Row>
      <Row label={t("diagnostics-account-type")}>{data.account_type}</Row>
      <Row label={t("diagnostics-models-cached")}>
        {String(data.models_cached)}
      </Row>
      <Row label={t("diagnostics-web-search")}>
        {formatWebSearch(t, data.web_search)}
      </Row>
      <Row label={t("diagnostics-github-copilot")}>
        {deriveGithubCopilotStatus(t, data.tokens)}
      </Row>
      <Row label={t("diagnostics-rate-limit")}>
        {formatRateLimit(t, data.rate_limit)}
      </Row>
    </dl>
  )
}

/** The collapsible "Copilot service" disclosure (upstream hosts/URLs). */
function ServiceDisclosure({
  t,
  svc,
}: {
  t: TranslateFn
  // Typed optional on purpose: `apiCall` casts the response body without
  // validating it (see proxy/client.ts), so an older sidecar that predates
  // the `copilot_service` field sends it as undefined. Dereferencing it
  // unguarded threw and crashed the whole island to blank.
  svc: DiagnosticsResponse["copilot_service"] | undefined
}): ReactElement | null {
  const none = t("diagnostics-value-none")
  if (!svc) return null
  return (
    <Disclosure
      summary={
        <span className="advanced-section__title">
          {t("diagnostics-service-config")}
        </span>
      }
    >
      <dl className="kv kv--bare">
        <Row label={t("diagnostics-upstream-host")}>{svc.upstream_host}</Row>
        <Row label={t("diagnostics-github-api")}>{svc.github_api_base_url}</Row>
        <Row label={t("diagnostics-token-endpoint")}>{svc.token_endpoint}</Row>
        <Row label={t("diagnostics-enterprise-domain")}>
          {svc.enterprise_domain ?? none}
        </Row>
        <Row label={t("diagnostics-discovered-upstream")}>
          {svc.discovered_upstream ?? none}
        </Row>
      </dl>
    </Disclosure>
  )
}

/** The chrome-free "Quit Maximal" lifecycle block. */
function QuitBlock({ t }: { t: TranslateFn }): ReactElement {
  const [quitError, setQuitError] = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)

  const onQuit = (): void => {
    setDisabled(true)
    setQuitError(null)
    // A browser tab has no Tauri host, so POST /_internal/quit: the sidecar
    // signals the shell to confirm-and-exit. 202 → shell owns it (stay
    // disabled); 409 → plain CLI, nothing to quit; other → failed.
    void fetch("/_internal/quit", { method: "POST" }).then(
      (res) => {
        if (res.status === 409) {
          setQuitError("Not running under the menu-bar app — nothing to quit.")
          setDisabled(false)
        } else if (!res.ok) {
          setQuitError(`Quit failed (HTTP ${res.status}).`)
          setDisabled(false)
        }
      },
      () => {
        setQuitError("Quit request failed.")
        setDisabled(false)
      },
    )
  }

  return (
    <div className="state">
      <h4 className="state__title">{t("diagnostics-quit-title")}</h4>
      <p className="state__body">{t("diagnostics-quit-desc")}</p>
      <div className="actions">
        <Button variant="secondary" onClick={onQuit} disabled={disabled}>
          {t("diagnostics-quit-button")}
        </Button>
      </div>
      {quitError && <p className="card__hint">{quitError}</p>}
    </div>
  )
}

/** The Uninstall card + its Radix-backed confirmation dialog. */
function UninstallCard({ t }: { t: TranslateFn }): ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [purge, setPurge] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const summary = (): string => {
    // --force always reverts every app integration (the in-app path can't
    // surface the CLI's per-app prompt), so that clause is never opt-in.
    const clauses = [
      t("uninstall-clause-cli"),
      t("uninstall-clause-integrations"),
    ]
    if (purge) clauses.push(t("uninstall-clause-purge"))
    const tail =
      clauses.length > 1 ?
        t("uninstall-summary-tail", { last: clauses.pop() ?? "" })
      : ""
    return `${clauses.join(", ")}${tail}`
  }

  const onConfirm = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      await invokeCommand("uninstall_maximal", { purge })
      setConfirmOpen(false)
      setDone(true)
    } catch (err) {
      // Tauri rejects with the Err(String) reason (or a generic message in a
      // plain browser with no host). Surface it inline.
      console.warn("invoke(uninstall_maximal) failed:", err)
      setError(t("uninstall-err", { error: String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card__head">
        <h4 className="card__title">{t("uninstall-title")}</h4>
      </div>
      {done ?
        <p className="card__hint">{t("uninstall-complete")}</p>
      : <div className="uninstall-body">
          <p className="card__hint">
            {fillNode(t, "uninstall-hint", {
              name: "cliName",
              node: <code className="mono">maximal</code>,
            })}
          </p>
          <div className="uninstall-options">
            <label className="checkbox-label">
              <Checkbox checked={purge} onCheckedChange={setPurge} />
              <span>{t("uninstall-purge-label")}</span>
              <span className="uninstall-options__note mono">
                ~/.local/share/maximal
              </span>
            </label>
          </div>
          {error && (
            <div className="card__hint uninstall-error" role="alert">
              <span>{error}</span>
            </div>
          )}
          <div className="actions">
            <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
              {t("uninstall-button")}
            </Button>
          </div>
          <p className="card__hint">
            {fillNode(t, "uninstall-terminal-hint", {
              name: "uninstallCmd",
              node: <code className="mono">maximal uninstall</code>,
            })}
          </p>
        </div>
      }
      <ConfirmDialog
        open={confirmOpen}
        title={t("uninstall-title")}
        body={t("uninstall-confirm", { summary: summary() })}
        confirmLabel={t("uninstall-button")}
        cancelLabel={t("common-cancel")}
        tone="danger"
        busy={busy}
        onConfirm={onConfirm}
        onCancel={() => {
          if (!busy) setConfirmOpen(false)
        }}
      />
    </div>
  )
}

/**
 * The Diagnostics section, as a React island. Ports the imperative renderers +
 * native handlers from main.ts: live state via `useDiagnostics`, the "Copilot
 * service" disclosure, and the Quit / Uninstall / Reveal / Copy actions. The
 * uninstall confirmation is a Radix-backed ConfirmDialog (replacing the old
 * `window.confirm`).
 */
export function Diagnostics(): ReactElement {
  const t = useT()
  const { data, updateStatus, isLoading, error, refresh } = useDiagnostics()

  const onCopy = (): void => {
    if (!data) return
    void navigator.clipboard
      .writeText(JSON.stringify(data, null, 2))
      .catch((err: unknown) => console.error("clipboard write failed", err))
  }

  return (
    <Stack proximity="region" aria-busy={isLoading}>
      {error && (
        <div className="card__hint" role="alert">
          <span>{t("diagnostics-err-load", { error })}</span>{" "}
          <Button variant="ghost" onClick={() => void refresh()}>
            {t("common-retry")}
          </Button>
        </div>
      )}

      {data && (
        <>
          <InfoList t={t} data={data} updateStatus={updateStatus} />
          <ServiceDisclosure t={t} svc={data.copilot_service} />
        </>
      )}

      {isLoading && !data && !error && (
        <p className="state__caption">Loading diagnostics…</p>
      )}

      <div className="actions">
        <Button variant="primary" onClick={onCopy} disabled={!data}>
          {t("diagnostics-copy-bundle")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void safeInvoke("reveal_config_dir")}
        >
          {t("reveal-config")}
        </Button>
        <Button
          variant="secondary"
          disabled
          title={t("diagnostics-restart-proxy-title")}
        >
          {t("diagnostics-restart-proxy")}
        </Button>
      </div>

      <div className="subsection">
        <h3 className="subsection__title">{t("diagnostics-manage-title")}</h3>
        <QuitBlock t={t} />
        <UninstallCard t={t} />
      </div>
    </Stack>
  )
}
