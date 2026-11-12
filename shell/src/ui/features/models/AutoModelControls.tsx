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

type ModelSetting = "fast" | "capable" | "classifier";

interface TierControlProps {
  tier: ModelSetting;
  state: ClaudeAutoTierState;
  models: ClaudeAutoModelsState;
  saving: boolean;
  onChange: (value: string | null) => void;
}

const EXTERNAL_DEFAULT_VALUE = "__claude-code-default__";

const COPY_KEYS: Record<
  ModelSetting,
  { label: string; hint: string; unavailable: string }
> = {
  fast: {
    label: "models-auto-fast-label",
    hint: "models-auto-fast-hint",
    unavailable: "models-auto-fast-unavailable-title",
  },
  capable: {
    label: "models-auto-capable-label",
    hint: "models-auto-capable-hint",
    unavailable: "models-auto-capable-unavailable-title",
  },
  classifier: {
    label: "models-auto-classifier-label",
    hint: "models-auto-classifier-hint",
    unavailable: "models-auto-classifier-unavailable-title",
  },
};

function optionLabel(
  option: ClaudeAutoModelsState["options"][number],
): string {
  return t(option.preview ? "models-auto-option-preview" : "models-auto-option", {
    name: option.name,
    vendor: option.vendor,
  });
}

function optionsForTier(
  models: ClaudeAutoModelsState,
  tier: ModelSetting,
): ClaudeAutoModelsState["options"] {
  return tier === "classifier" ? models.classifier_options : models.options;
}

function effectiveName(
  state: ClaudeAutoTierState,
  models: ClaudeAutoModelsState,
): string {
  if (!state.effective) return "";
  const options = [...models.options, ...models.classifier_options];
  return (
    options.find((option) => option.id === state.effective)?.name ??
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

function selectionValue(state: ClaudeAutoTierState): string {
  if (state.configured) return state.configured;
  if (state.source !== "claude-code-setting") return "";
  if (state.status === "ready") return EXTERNAL_DEFAULT_VALUE;
  return state.effective ?? EXTERNAL_DEFAULT_VALUE;
}

function TierControl({ tier, state, models, saving, onChange }: TierControlProps) {
  const copy = COPY_KEYS[tier];
  const status = statusText(state, models);
  const selectId = `models-auto-${tier}`;
  const problemId = `${selectId}-problem`;
  const hasProblem = state.status !== "ready";
  const options = optionsForTier(models, tier);
  const value = selectionValue(state);
  const unavailableId =
    state.status === "unavailable"
      ? (state.configured ?? state.effective)
      : null;
  const showUnavailable =
    unavailableId !== null &&
    !options.some((option) => option.id === unavailableId);
  const showExternalSetting = value === EXTERNAL_DEFAULT_VALUE;
  const externalSettingLabel =
    state.effective ?
      t("models-auto-effective-external", {
        modelName: effectiveName(state, models),
      })
    : t("models-auto-effective-external-default");

  return (
    <div className="models-auto__row">
      <label className="models-auto__label" htmlFor={selectId}>
        <span className="models-auto__row-title">{t(copy.label)}</span>
        <span className="models-auto__row-hint">{t(copy.hint)}</span>
      </label>
      <div className="models-auto__control">
        <select
          id={selectId}
          className="select"
          value={value}
          disabled={saving}
          aria-describedby={hasProblem ? problemId : undefined}
          onChange={(event) => {
            const selected = event.currentTarget.value;
            if (selected !== EXTERNAL_DEFAULT_VALUE) {
              onChange(selected || null);
            }
          }}
        >
          <option value="">{t("models-auto-automatic")}</option>
          {showExternalSetting && (
            <option value={EXTERNAL_DEFAULT_VALUE}>{externalSettingLabel}</option>
          )}
          {showUnavailable && (
            <option value={unavailableId ?? ""}>
              {t("models-auto-option-unavailable", { id: unavailableId })}
            </option>
          )}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        {status && <p className="panel-status">{status}</p>}
        {hasProblem && (
          <div id={problemId}>
            <TierProblem tier={tier} state={state} />
          </div>
        )}
      </div>
    </div>
  );
}

function TierProblem({
  tier,
  state,
}: {
  tier: ModelSetting;
  state: ClaudeAutoTierState;
}): JSX.Element | null {
  if (state.status === "ready") return null;
  if (state.status === "unavailable") {
    return (
      <Callout tone="notice" title={t(COPY_KEYS[tier].unavailable)}>
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
  const updateClassifier = (classifier: string | null): void => {
    void onChange({ classifier });
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
        <TierControl
          tier="classifier"
          state={state.classifier}
          models={state}
          saving={saving}
          onChange={updateClassifier}
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
    </section>
  );
}
