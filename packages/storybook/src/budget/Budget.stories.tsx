import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { Budget } from "../../../../shell/src/ui/features/budget/Budget";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * The Rules surface: the summary, Rules, Activity and Settings over `/settings/api/budget`
 * and `/settings/api/budget/activity` from the mock sidecar
 * (scripts/ui-harness-budget.ts, a small working budget service over a made-up
 * spend ledger). Every story is a backend state; changes made in a story
 * (adding, editing or deleting a limit, the switch, the unit) go through the
 * same requests the app sends and come back as `budget.changed`.
 */
const meta = {
  title: "Rules/Rules",
  component: Budget,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof Budget>;
export default meta;
type Story = StoryObj<typeof meta>;

const state = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });

/** Rules that are fine, nearly spent and spent, with a week of activity and the provider's allowances. */
export const Limits = state({ scenario: "budget-limits" });
/** Enforcement switched off: the rules are kept and listed, none refuses a request. */
export const EnforcementOff = state({ scenario: "budget-off" });
/** Spend and a provider allowance, but no rules yet: nothing is listed per model, and Add a rule is the way in. */
export const NoLimitsYet = state({ scenario: "budget-no-limits" });
/** First run: no rules, no provider report, nothing spent. */
export const FirstRun = state({ scenario: "budget-empty" });
/** Amounts shown in AI credits instead of US dollars. */
export const InCredits = state({ scenario: "budget-credits" });
/** No usage database: every amount reads zero, and the summary says why. */
export const NoUsageDatabase = state({ scenario: "budget-storage-off" });

export const Loading = state({
  scenario: "budget-limits",
  overrides: {
    "/settings/api/budget": "hang",
    "/settings/api/budget/activity": "hang",
  },
});
export const LoadError = state({
  scenario: "budget-limits",
  overrides: {
    "/settings/api/budget": { status: 500, body: { error: { message: "Budget settings are unreadable." } } },
  },
});
/** Maximal not answering, after ~5s of automatic retries. */
export const Unreachable = state({
  scenario: "budget-limits",
  overrides: { "/settings/api/budget": "offline", "/settings/api/budget/activity": "offline" },
});
/** The rules load but the spend behind the chart can't: the error sits in Activity, the rest stays usable. */
export const ActivityLoadError = state({
  scenario: "budget-limits",
  overrides: {
    "/settings/api/budget/activity": { status: 500, body: { error: { message: "Usage history is unreadable." } } },
  },
});
/** Activity is slow: the summary and Rules are up while it loads. */
export const ActivityLoading = state({
  scenario: "budget-limits",
  overrides: { "/settings/api/budget/activity": "hang" },
});
/** Changing the switch or unit takes a beat, so the controls disable while it saves. */
export const SlowSave = state({ scenario: "budget-limits", latencyMs: 1200 });

const range = (canvasElement: HTMLElement) => within(canvasElement).findByRole("group", { name: "Range" });

/** Activity over the last 24 hours, by hour: the totals strip, columns on an hourly axis, and a table newest hour first. */
export const ActivityByHour: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(await range(canvasElement)).findByRole("button", { name: "24 hours" }));
    await userEvent.selectOptions(await within(canvasElement).findByLabelText("Group by"), "hour");
  },
};

/** Ninety days by day: a long run of columns, packed closer, with the busiest day named under them. */
export const ActivityNinetyDays: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(await range(canvasElement)).findByRole("button", { name: "90 days" }));
    await userEvent.selectOptions(await within(canvasElement).findByLabelText("Group by"), "day");
  },
};

/** Everything recorded, by client key. */
export const ActivityAllTime: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(await range(canvasElement)).findByRole("button", { name: "All time" }));
    await userEvent.selectOptions(await within(canvasElement).findByLabelText("Group by"), "key");
  },
};

/** Custom opens two day fields; the range is UTC days, the last one included. */
export const ActivityCustomRange: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(await range(canvasElement)).findByRole("button", { name: "Custom" }));
  },
};

/** A custom range that runs backwards says so and asks for nothing. */
export const ActivityBackwardsRange: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await within(await range(canvasElement)).findByRole("button", { name: "Custom" }));
    const from = await canvas.findByLabelText("From");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-01-10");
    const to = await canvas.findByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-01-05");
  },
};

/** A range that recorded nothing: an empty state that says so and suggests a longer range. */
export const ActivityNothingInRange: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: {
        "/settings/api/budget/activity": {
          status: 200,
          body: {
            period: "range",
            group: "model",
            period_start: "2026-11-04T00:00:00.000Z",
            display: { unit: "usd", credit_usd: 0.01 },
            range: { from: "2026-11-04T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z", label: "7d" },
            totals: {
              request_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              total_tokens: 0,
              total_nano_aiu: 0,
            },
            rows: [],
          },
        },
      },
    },
  },
};

/** The add form, opened from "Add a rule". */
export const AddLimitDialog: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Add a rule" }));
  },
};

/** The edit form for a rule that follows the provider's monthly allowance. */
export const EditLimitDialog: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Edit Monthly cap" }));
  },
};

/** Deleting asks first and says what stays. */
export const DeleteConfirm: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Delete Images per day" }));
  },
};

/** Saving a rule the server refuses puts the reason in the dialog. */
export const SaveFailure: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-no-limits",
      overrides: {
        "/settings/api/budget/limits/everything-daily": {
          status: 500,
          body: { error: { message: "Could not write config" } },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add a rule" }));
    await userEvent.type(await canvas.findByLabelText("Amount"), "2");
    await userEvent.click(await canvas.findByRole("button", { name: "Save rule" }));
  },
};

/** An amount that isn't one: the caption says what to type, the field is focused, and the dialog keeps every value. */
export const AmountProblem: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add a rule" }));
    await userEvent.type(await canvas.findByLabelText("Name"), "My cap");
    await userEvent.type(await canvas.findByLabelText("Amount"), "lots");
    await userEvent.click(await canvas.findByRole("button", { name: "Save rule" }));
  },
};

// ---- How each rule performs ------------------------------------------------

const openHistory = (name: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: new RegExp(`^Show how ${name} is performing`) }));
};

const timelinePath = (id: string) => `/settings/api/budget/limits/${id}/timeline`;

/** A rule that is fine: spend climbing toward the limit, the warning line, where the period resets. Each row also has a sparkline. */
export const RuleHistory: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: openHistory("Monthly cap"),
};

/** A spent rule: it warned, reached its limit and refused requests in every period, marked on the limit line. */
export const RuleHistorySpent: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: openHistory("Client codex"),
};

/** The same history in a narrow window. */
export const RuleHistoryNarrow: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  decorators: [(Story) => <div className="sb-pane" style={{ maxWidth: 640 }}><Story /></div>],
  play: openHistory("Client codex"),
};

/** The history takes a while: the row shows it is loading. */
export const RuleHistoryLoading: Story = {
  parameters: { mockApi: { scenario: "budget-limits", overrides: { [timelinePath("key-codex-weekly")]: "hang" } } },
  play: openHistory("Client codex"),
};

/** The history can't load: an error with a retry, and the rest of the window stays usable. */
export const RuleHistoryError: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: { [timelinePath("key-codex-weekly")]: { status: 500, body: { error: { message: "History is unreadable." } } } },
    },
  },
  play: openHistory("Client codex"),
};

/** Nothing matched the rule in the range. */
export const RuleHistoryEmpty: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: {
        [timelinePath("key-codex-weekly")]: {
          status: 200,
          body: {
            limit: {
              id: "key-codex-weekly",
              label: null,
              scope: { kind: "key", id: "codex" },
              action: "block",
              limit_reset: "weekly",
              warn_at: 0.8,
              limit: 1_800_000_000,
              warn_line: 1_440_000_000,
              display: { limit: 1.8, warn_line: 1.44 },
            },
            display: { unit: "usd", credit_usd: 0.01 },
            range: { from: "2026-10-13T00:00:00.000Z", to: "2026-11-12T00:00:00.000Z", label: "30d", bucket: "day" },
            buckets: [],
            periods: [],
            markers: [],
            totals: { nano_aiu: 0, requests: 0, refused: 0, refused_estimate_nano_aiu: 0, periods_crossed: 0 },
          },
        },
      },
    },
  },
  play: openHistory("Client codex"),
};

// ---- What if, in the editor --------------------------------------------------

const draftRule = (amount: string, target = "codex") => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Add a rule" }));
  await userEvent.selectOptions(await canvas.findByLabelText("Applies to"), "key");
  await userEvent.selectOptions(await canvas.findByLabelText("Client key"), target);
  await userEvent.type(await canvas.findByLabelText("Amount"), amount);
};

/** The preview with nothing typed yet: it says what it needs. */
export const WhatIfWaiting: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Add a rule" }));
  },
};

/** A tight cap replayed over 30 days: when it would have warned and tripped, the requests it would have refused, and a suggestion. */
export const WhatIfTightCap: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: draftRule("1"),
};

/** A cap well above anything spent: it never warns or trips, and the suggestion is what would have fit. */
export const WhatIfLooseCap: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: draftRule("500"),
};

/** A rule that only warns refuses nothing, and says so. */
export const WhatIfWarnOnly: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async (context) => {
    await draftRule("1")(context);
    await userEvent.selectOptions(await within(context.canvasElement).findByLabelText("When it’s reached"), "warn");
  },
};

/** One click puts the suggested amount in the field; everything else typed stays. */
export const WhatIfUseSuggestion: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await draftRule("1")(context);
    await userEvent.type(await canvas.findByLabelText("Name"), "Codex cap");
    await userEvent.click(await canvas.findByRole("button", { name: /^Use / }));
  },
};

/** A client key nothing has used: there is nothing to replay. */
export const WhatIfNothingToReplay: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: draftRule("5", "claude-desktop"),
};

/** The replay can't run: the form stays as typed and the preview says why, with a retry. */
export const WhatIfError: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-no-limits",
      overrides: { "/settings/api/budget/simulate": { status: 500, body: { error: { message: "Usage history is unreadable." } } } },
    },
  },
  play: draftRule("1"),
};

/** A slow replay: the preview shows it is working. */
export const WhatIfLoading: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits", overrides: { "/settings/api/budget/simulate": "hang" } } },
  play: draftRule("1"),
};
