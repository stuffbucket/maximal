import type {
  ClaudeAutoModelsState,
  ClaudeAutoModelsUpdateRequest,
  ClaudeAutoTierState,
} from "../../../../../src/lib/config/settings-types";

import { t } from "../../../i18n";
import { Callout } from "../../components/Callout";

interface AutoModelControlsProps {
  state: ClaudeAutoModelsState;
  saving: boolean;
  onChange: (selection: ClaudeAutoModelsUpdateRequest) => Promise<void>;
}

interface TierControlProps {
  tier: "fast" | "capable";
  state: ClaudeAutoTierState;
  models: ClaudeAutoModelsState;
  saving: boolean;
  onChange: (value: string | null) => void;
}

function optionLabel(
  option: ClaudeAutoModelsState["options"][number],
): string {
  return t(option.preview ? "models-auto-option-preview" : "models-auto-option", {
    name: option.name,
    vendor: option.vendor,
  });
}

function effectiveName(
  state: ClaudeAutoTierState,
  models: ClaudeAutoModelsState,
): string {
  if (!state.effective) return "";
  return (
    models.options.find((option) => option.id === state.effective)?.name ??
    state.effective
  );
}

function statusText(
  state: ClaudeAutoTierState,
  models: ClaudeAutoModelsState,
): string | null {
  if (state.status !== "ready") return null;
  if (state.source === "claude-code-setting" && !state.effective) {
    return t("models-auto-effective-external-default");
  }
  const modelName = effectiveName(state, models);
  if (state.source === "automatic") {
    return t("models-auto-effective-automatic", { modelName });
  }
  if (state.source === "claude-code-setting") {
    return t("models-auto-effective-external", { modelName });
  }
  return t("models-auto-effective-override", { modelName });
}

function TierControl({ tier, state, models, saving, onChange }: TierControlProps) {
  const labelKey =
    tier === "fast" ? "models-auto-fast-label" : "models-auto-capable-label";
  const hintKey =
    tier === "fast" ? "models-auto-fast-hint" : "models-auto-capable-hint";
  const status = statusText(state, models);
  const selectId = `models-auto-${tier}`;
  const unavailable = state.reason === "override-unavailable";

  return (
    <div className="models-auto__row">
      <label className="models-auto__label" htmlFor={selectId}>
        <span className="models-auto__row-title">{t(labelKey)}</span>
        <span className="models-auto__row-hint">{t(hintKey)}</span>
      </label>
      <div className="models-auto__control">
        <select
          id={selectId}
          className="select"
          value={state.configured ?? ""}
          disabled={saving}
          onChange={(event) => onChange(event.currentTarget.value || null)}
        >
          <option value="">{t("models-auto-automatic")}</option>
          {unavailable && (
            <option value={state.configured ?? ""}>
              {t("models-auto-option-unavailable", { id: state.configured })}
            </option>
          )}
          {models.options.map((option) => (
            <option key={option.id} value={option.id}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        {status && <p className="panel-status">{status}</p>}
      </div>
    </div>
  );
}

function TierProblem({
  tier,
  state,
}: {
  tier: "fast" | "capable";
  state: ClaudeAutoTierState;
}): JSX.Element | null {
  if (state.status === "ready") return null;
  if (state.status === "unavailable") {
    return (
      <Callout
        tone="notice"
        title={t(
          tier === "fast"
            ? "models-auto-fast-unavailable-title"
            : "models-auto-capable-unavailable-title",
        )}
      >
        <p>{t("models-auto-unavailable-detail")}</p>
      </Callout>
    );
  }
  return (
    <Callout tone="notice" title={t("models-auto-unresolved-title")}>
      <p>{t("models-auto-unresolved-detail")}</p>
    </Callout>
  );
}

export function AutoModelControls({
  state,
  saving,
  onChange,
}: AutoModelControlsProps): JSX.Element {
  const updateFast = (fast: string | null): void => {
    void onChange({ fast });
  };
  const updateCapable = (capable: string | null): void => {
    void onChange({ capable });
  };

  return (
    <section className="subsection models-auto" aria-labelledby="models-auto-title">
      <div className="models-auto__head">
        <h3 className="subsection__title" id="models-auto-title">
          {t("models-auto-title")}
        </h3>
        <p className="models-auto__intro">{t("models-auto-intro")}</p>
      </div>
      <div className="models-auto__rows">
        <TierControl
          tier="fast"
          state={state.fast}
          models={state}
          saving={saving}
          onChange={updateFast}
        />
        <TierControl
          tier="capable"
          state={state.capable}
          models={state}
          saving={saving}
          onChange={updateCapable}
        />
      </div>
      {saving && (
        <p className="panel-status" role="status">
          {t("models-auto-saving")}
        </p>
      )}
      {!state.applied && (
        <p className="panel-status">{t("models-auto-not-applied")}</p>
      )}
      <TierProblem tier="fast" state={state.fast} />
      <TierProblem tier="capable" state={state.capable} />
    </section>
  );
}
