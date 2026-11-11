import { useEffect, useId, useMemo, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginDetailView, PluginUpdateRequest } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Switch } from "../../components/Switch";
import type { Problem } from "../../problems";

import {
  type ConfigField,
  type Draft,
  configFields,
  configFrom,
  draftFrom,
  issuesByField,
  sameDraft,
} from "./config-form";
import { ChevronGlyph } from "./glyphs";
import type { ConnectorUpdateResult } from "./useConnectorDetail";

const SAVED_FLASH_MS = 2000;

interface ConfigFormProps {
  connector: PluginDetailView & { configSchema: NonNullable<PluginDetailView["configSchema"]> };
  onSave: (change: PluginUpdateRequest) => Promise<ConnectorUpdateResult>;
}

/**
 * Configuration: a form generated from the connector's config schema. Edits
 * stay local until Save; Revert puts back what's saved. The connector
 * validates on save, and its complaints land next to the fields they're
 * about (anything else above the form).
 */
export function ConfigForm({ connector, onSave }: ConfigFormProps): JSX.Element {
  const fields = useMemo(() => configFields(connector.configSchema), [connector.configSchema]);
  const saved = useMemo(() => draftFrom(fields, connector.config), [fields, connector.config]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, Array<string>>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // Folded unless the connector failed to start: then its config is the
  // likely cause, and the fields to fix shouldn't hide.
  const [advancedOpen, setAdvancedOpen] = useState(connector.lifecycle === "failed");
  const advancedId = useId();
  const dirty = !sameDraft(draft, saved);

  // A fresh copy from the server replaces the form after our own save, or
  // (another window, a reload) while there's nothing unsaved in it.
  const [base, setBase] = useState(saved);
  const adoptNext = useRef(false);
  useEffect(() => {
    if (sameDraft(saved, base)) return;
    const adopt = adoptNext.current;
    adoptNext.current = false;
    setBase(saved);
    setDraft((current) => (adopt || sameDraft(current, base) ? saved : current));
  }, [saved, base]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), SAVED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const set = (key: string, value: string | boolean): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setJustSaved(false);
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    setErrors({});
    // Set before the call: the reply reaches `saved` as part of it.
    adoptNext.current = true;
    const result = await onSave({ config: configFrom(fields, draft, connector.config) });
    setSaving(false);
    if (result.ok) {
      setJustSaved(true);
      return;
    }
    adoptNext.current = false;
    if (result.issues && result.issues.length > 0) {
      const byField = issuesByField(result.issues, fields);
      setErrors(byField);
      if (fields.some((field) => field.advanced && byField[field.key])) setAdvancedOpen(true);
    } else if (result.problem) setProblem(result.problem);
  };

  const revert = (): void => {
    setDraft(saved);
    setErrors({});
    setProblem(null);
  };

  const basic = fields.filter((field) => !field.advanced);
  const advanced = fields.filter((field) => field.advanced);
  const general = errors[""];

  return (
    <section className="connector-section" aria-labelledby={`${connector.id}-config-title`}>
      <div className="connector-section__head">
        <h4 className="connector-section__title" id={`${connector.id}-config-title`}>
          {t("connectors-config-title")}
        </h4>
        <p className="connector-section__sub">
          {t("connectors-config-sub", { connector: connector.displayName })}
        </p>
      </div>

      {general && (
        <Callout tone="error" title={t("connectors-config-rejected", { connector: connector.displayName })}>
          {general.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </Callout>
      )}
      {problem && <ProblemCallout problem={problem} onRetry={() => void save()} />}

      {/* The connector validates; the browser's own bubbles would pre-empt it
          (a type="url" field) in words the connector doesn't use. */}
      <form
        className="form connector-config"
        noValidate
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !saving) void save();
        }}
      >
        <fieldset className="connector-config__fields" disabled={saving}>
          <legend className="sr-only">{t("connectors-config-title")}</legend>
          {basic.map((field) => (
            <FieldRow key={field.key} field={field} value={draft[field.key]} config={connector.config} errors={errors[field.key]} onChange={set} />
          ))}
          {advanced.length > 0 && (
            <div className="connector-config__advanced">
              <button
                type="button"
                className="twirl connector-config__advanced-toggle"
                aria-expanded={advancedOpen}
                aria-controls={advancedId}
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <ChevronGlyph className="twirl__chevron" />
                <span>{t("connectors-config-advanced")}</span>
              </button>
              <div id={advancedId} hidden={!advancedOpen}>
                {advanced.map((field) => (
                  <FieldRow key={field.key} field={field} value={draft[field.key]} config={connector.config} errors={errors[field.key]} onChange={set} />
                ))}
              </div>
            </div>
          )}
        </fieldset>

        <div className="connector-config__actions">
          <Button type="submit" variant="primary" size="sm" disabled={!dirty || saving}>
            {saving ? t("connectors-saving") : t("connectors-config-save")}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={revert}>
            {t("connectors-config-revert")}
          </Button>
          <span className="connector-config__saved" role="status">
            {justSaved ? t("connectors-config-saved") : ""}
          </span>
        </div>
      </form>
    </section>
  );
}

interface FieldRowProps {
  field: ConfigField;
  value: string | boolean | undefined;
  config: Record<string, unknown> | undefined;
  errors?: Array<string>;
  onChange: (key: string, value: string | boolean) => void;
}

function FieldRow({ field, value, config, errors, onChange }: FieldRowProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [field.description && hintId, errors && errorId].filter(Boolean).join(" ") || undefined;
  const placeholder =
    field.defaultValue !== undefined && field.defaultValue !== null && typeof field.defaultValue !== "object"
      ? String(field.defaultValue)
      : undefined;

  let control: JSX.Element;
  switch (field.control) {
    case "boolean":
      control = (
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(next) => onChange(field.key, next)}
        />
      );
      break;
    case "enum":
      control = (
        <select
          id={id}
          className="select"
          value={typeof value === "string" ? value : ""}
          aria-invalid={errors ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.key, event.target.value)}
        >
          {!field.required && <option value="">{placeholder ?? t("connectors-config-unset")}</option>}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;
    case "json":
      control = (
        <pre className="connector-config__json mono" id={id} aria-describedby={describedBy}>
          {JSON.stringify(config?.[field.key] ?? field.defaultValue ?? null, null, 2)}
        </pre>
      );
      break;
    default:
      control = (
        <input
          id={id}
          className="input"
          type={field.control === "number" ? "text" : field.inputType}
          inputMode={field.control === "number" ? (field.integer ? "numeric" : "decimal") : undefined}
          spellCheck={false}
          autoComplete="off"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          required={field.required}
          aria-invalid={errors ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      );
  }

  return (
    <div className="form__row connector-config__row">
      <div className="form__label">
        {field.control === "json" ? (
          <span className="connector-config__label">{field.label}</span>
        ) : (
          <label htmlFor={id}>{field.label}</label>
        )}
        {field.description && (
          <p className="form__hint" id={hintId}>
            {field.description}
          </p>
        )}
        {field.control === "json" && <p className="form__hint">{t("connectors-config-readonly")}</p>}
      </div>
      <div className="connector-config__control">
        {control}
        {errors && (
          <p className="state__caption state__caption--error" id={errorId}>
            {errors.join(" ")}
          </p>
        )}
      </div>
    </div>
  );
}
