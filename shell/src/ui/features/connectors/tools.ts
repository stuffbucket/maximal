import { resolveLocale, t } from "../../../i18n";
import type {
  JsonSchemaObject,
  PluginToolView,
  ToolGroup,
  ToolPermission,
} from "../../../proxy/client";

/** Page order of the permission groups. */
export const GROUP_ORDER: ReadonlyArray<ToolGroup> = ["read-only", "write-delete", "other"];

export function groupLabel(group: ToolGroup): string {
  switch (group) {
    case "read-only":
      return t("connectors-group-read-only");
    case "write-delete":
      return t("connectors-group-write-delete");
    case "other":
      return t("connectors-group-other");
  }
}

/** `fetch_blob` → "Fetch blob". Only the first letter is raised, so an
 *  acronym in the name stays as written ("accept_eula" → "Accept eula"). */
export function humanizeName(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What a person calls the tool: its own title, else a humanized name. */
export function toolTitle(tool: Pick<PluginToolView, "name" | "title" | "annotations">): string {
  return tool.title ?? tool.annotations?.title ?? humanizeName(tool.name);
}

export interface ToolInput {
  name: string;
  /** First non-null JSON Schema type; absent for unions and untyped inputs. */
  type?: string;
  required: boolean;
  description?: string;
}

function firstType(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const type = (schema as { type?: unknown }).type;
  if (typeof type === "string") return type === "null" ? undefined : type;
  if (Array.isArray(type)) {
    return type.find((entry): entry is string => typeof entry === "string" && entry !== "null");
  }
  return undefined;
}

/** The top-level properties of an input schema, in schema order. */
export function toolInputs(schema: JsonSchemaObject): Array<ToolInput> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as Array<unknown>) : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, property]) => {
    const description = (property as { description?: unknown } | null)?.description;
    return {
      name,
      type: firstType(property),
      required: required.has(name),
      description: typeof description === "string" && description.trim() !== "" ? description : undefined,
    };
  });
}

/** How many input names the summary spells out before "and N more". */
const SUMMARY_NAMES = 3;

/** "Takes 5 inputs: query, includeDeveloperCard, agentId, and 2 more". */
export function inputsSummary(inputs: ReadonlyArray<ToolInput>): string {
  const names = inputs.map((input) => input.name);
  const shown = names.length > SUMMARY_NAMES ? names.slice(0, SUMMARY_NAMES) : names;
  const rest = names.length - shown.length;
  const items = rest > 0 ? [...shown, t("connectors-tool-inputs-more", { count: rest })] : shown;
  return t("connectors-tool-inputs", { count: names.length, list: formatList(items) });
}

/** The shell's lib target predates `Intl.ListFormat`'s types; every webview
 *  Maximal runs in has it. */
type ListFormatCtor = new (
  locale: string,
  options: { type: "conjunction" },
) => { format: (items: Array<string>) => string };

/** "a, b, and c", in the UI's language. */
function formatList(items: Array<string>): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat;
  if (!ListFormat) return items.join(", ");
  try {
    return new ListFormat(resolveLocale(), { type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/** A group's permission as its menu shows it: one shared value, or custom. */
export type GroupPermission = ToolPermission | "custom";

export function groupPermission(tools: ReadonlyArray<Pick<PluginToolView, "permission">>): GroupPermission {
  const first = tools[0]?.permission;
  if (first === undefined) return "allow";
  return tools.every((tool) => tool.permission === first) ? first : "custom";
}

/** "3 days ago", in the UI's language. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - now) / 1000);
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [candidate, size] of steps) {
    unit = candidate;
    if (Math.abs(value) < size) break;
    value = Math.round(value / size);
  }
  try {
    return new Intl.RelativeTimeFormat(resolveLocale(), { numeric: "auto" }).format(value, unit);
  } catch {
    return iso;
  }
}
