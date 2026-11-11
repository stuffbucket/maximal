import type { JsonSchemaObject, PluginValidationIssue } from "../../../proxy/client";

import { humanizeName } from "./tools";

/**
 * The Configuration form, generated from a connector's `configSchema`.
 *
 * Supported (docs: settings-types → PluginDetailView.configSchema): an object
 * whose properties are strings (`format: "uri"` gets a URL field), booleans,
 * numbers/integers and enums, each with an optional `title`, `description`
 * and `default`. `"x-maximal-advanced": true` folds a field under Advanced.
 * Anything else is shown read-only as JSON and sent back unchanged.
 */
export type ConfigField =
  | (FieldBase & { control: "text"; inputType: "text" | "url" })
  | (FieldBase & { control: "boolean" })
  | (FieldBase & { control: "number"; integer: boolean })
  | (FieldBase & { control: "enum"; options: Array<string> })
  | (FieldBase & { control: "json" });

interface FieldBase {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  advanced: boolean;
  defaultValue?: unknown;
}

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema {
  return typeof value === "object" && value !== null ? (value as Schema) : {};
}

/** A nullable type (`["string", "null"]`) reads as its non-null part. */
function primaryType(schema: Schema): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const real = type.filter((entry) => entry !== "null");
    return real.length === 1 && typeof real[0] === "string" ? real[0] : undefined;
  }
  return undefined;
}

function enumOptions(schema: Schema): Array<string> | null {
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) return null;
  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length === values.length ? strings : null;
}

export function configFields(schema: JsonSchemaObject): Array<ConfigField> {
  const properties = asSchema(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? (schema.required as Array<unknown>) : []);
  return Object.entries(properties).map(([key, raw]): ConfigField => {
    const property = asSchema(raw);
    const base: FieldBase = {
      key,
      label: typeof property.title === "string" ? property.title : humanizeName(key),
      description: typeof property.description === "string" ? property.description : undefined,
      required: required.has(key),
      advanced: property["x-maximal-advanced"] === true,
      defaultValue: property.default,
    };
    const options = enumOptions(property);
    if (options) return { ...base, control: "enum", options };
    switch (primaryType(property)) {
      case "string":
        return { ...base, control: "text", inputType: property.format === "uri" ? "url" : "text" };
      case "boolean":
        return { ...base, control: "boolean" };
      case "number":
      case "integer":
        return { ...base, control: "number", integer: primaryType(property) === "integer" };
      default:
        return { ...base, control: "json" };
    }
  });
}

/** What the form holds per field while editing: text for text-like
 *  controls (so a half-typed number survives), a boolean for switches. */
export type DraftValue = string | boolean;
export type Draft = Record<string, DraftValue>;

export function draftFrom(fields: ReadonlyArray<ConfigField>, config: Record<string, unknown> | undefined): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    const value = config?.[field.key];
    switch (field.control) {
      case "boolean":
        draft[field.key] = typeof value === "boolean" ? value : field.defaultValue === true;
        break;
      case "json":
        break;
      default:
        draft[field.key] = value === undefined || value === null ? "" : String(value);
    }
  }
  return draft;
}

export function sameDraft(a: Draft, b: Draft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * The config to send: the stored config with every editable field replaced
 * by its draft (read-only fields and unknown keys pass through). An empty
 * optional field is left out so the connector's default applies. A number
 * that doesn't parse stays a string so the connector's own validation
 * names the problem in its words.
 */
export function configFrom(
  fields: ReadonlyArray<ConfigField>,
  draft: Draft,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...stored };
  for (const field of fields) {
    if (field.control === "json") continue;
    const value = draft[field.key];
    if (field.control === "boolean") {
      config[field.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      delete config[field.key];
      continue;
    }
    if (field.control === "number") {
      const parsed = Number(text);
      config[field.key] = Number.isFinite(parsed) ? parsed : text;
      continue;
    }
    config[field.key] = text;
  }
  return config;
}

/** Issues by field key (`"config.endpoint"` → `endpoint`); the rest (the
 *  whole config, or a field the form doesn't show) under `""`. */
export function issuesByField(
  issues: ReadonlyArray<PluginValidationIssue>,
  fields: ReadonlyArray<ConfigField>,
): Record<string, Array<string>> {
  const keys = new Set(fields.map((field) => field.key));
  const out: Record<string, Array<string>> = {};
  for (const issue of issues) {
    const path = issue.path.startsWith("config.") ? issue.path.slice("config.".length) : issue.path;
    const head = path.split(".", 1)[0] ?? "";
    const key = keys.has(head) ? head : "";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
