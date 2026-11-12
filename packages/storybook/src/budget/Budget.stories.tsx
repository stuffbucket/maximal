import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useEffect } from "react";
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

// ---- Create rules from sessions ------------------------------------------------

const openSessions = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: "Create rules from sessions" }));
};

const pickSessions = (count: number) => async (context: { canvasElement: HTMLElement }) => {
  await openSessions(context);
  const boxes = await within(context.canvasElement).findAllByRole("checkbox");
  for (const box of boxes.slice(0, count)) await userEvent.click(box);
};

/** The picker: sessions over a range, biggest first, each with what it cost and the models it used. */
export const SessionsPicker: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: openSessions,
};

/** Three sessions picked, and a shape for the rules; the button says what it will size from. */
export const SessionsPicked: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async (context) => {
    await pickSessions(3)(context);
    await userEvent.selectOptions(await within(context.canvasElement).findByLabelText("Shape of the rules"), "daily-driver");
  },
};

/** The suggestion: each rule with what it would have done to the usage it was sized from, and how it was sized. */
export const SessionsSuggestion: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async (context) => {
    await pickSessions(3)(context);
    await userEvent.click(await within(context.canvasElement).findByRole("button", { name: /^Suggest rules from 3 sessions/ }));
  },
};

/** With no sessions picked: all usage in the range. A week of history is short, so no weekly rule. */
export const SessionsSuggestionFromRange: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async (context) => {
    await openSessions(context);
    await userEvent.click(await within(context.canvasElement).findByRole("button", { name: "Suggest rules from all usage in this range" }));
  },
};

/** The Team shape: one daily cap for each client key, biggest spender first. */
export const SessionsSuggestionTeam: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async (context) => {
    await openSessions(context);
    const canvas = within(context.canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText("Shape of the rules"), "team");
    await userEvent.click(await canvas.findByRole("button", { name: "Suggest rules from all usage in this range" }));
  },
};

/** A heavy-agent rule is rolling, which the editor can't set yet: it can only be added as it is. */
export const SessionsSuggestionRolling: Story = {
  parameters: { mockApi: { scenario: "budget-limits" } },
  play: async (context) => {
    await openSessions(context);
    const canvas = within(context.canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText("Shape of the rules"), "heavy-agent-use");
    await userEvent.click(await canvas.findByRole("button", { name: "Suggest rules from all usage in this range" }));
  },
};

/** One click adds a rule as drafted; its row says Added and stays, so the rest can still be read. */
export const SessionsAddOne: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async (context) => {
    await openSessions(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Suggest rules from all usage in this range" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add Daily cap" }));
  },
};

/** "Open in editor" opens the draft in the editor over the dialog, filled in, with its what-if. */
export const SessionsOpenInEditor: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async (context) => {
    await openSessions(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Suggest rules from all usage in this range" }));
    await userEvent.click((await canvas.findAllByRole("button", { name: "Open in editor" }))[0]!);
  },
};

/** Nothing was spent in what was picked: the note says there is nothing to size a rule to. */
export const SessionsNothingToSize: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: {
        "/settings/api/budget/suggest": {
          status: 200,
          body: {
            range: { from: "2026-11-05T00:00:00.000Z", to: "2026-11-12T00:00:00.000Z", label: "custom" },
            display: { unit: "usd", credit_usd: 0.01 },
            persona: null,
            sessions_considered: 0,
            requests_considered: 0,
            nano_aiu_considered: 0,
            limits: [],
            notes: ["no_spend"],
          },
        },
      },
    },
  },
  play: async (context) => {
    await openSessions(context);
    await userEvent.click(await within(context.canvasElement).findByRole("button", { name: "Suggest rules from all usage in this range" }));
  },
};

/** The suggestion can't be made: the picks stay, the dialog says why and offers another try. */
export const SessionsSuggestError: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: { "/settings/api/budget/suggest": { status: 500, body: { error: { message: "Usage history is unreadable." } } } },
    },
  },
  play: async (context) => {
    await pickSessions(2)(context);
    await userEvent.click(await within(context.canvasElement).findByRole("button", { name: /^Suggest rules from 2 sessions/ }));
  },
};

/** Sessions are slow to load. */
export const SessionsLoading: Story = {
  parameters: { mockApi: { scenario: "budget-limits", overrides: { "/settings/api/budget/sessions": "hang" } } },
  play: openSessions,
};

/** Sessions can't load: an error with a retry. */
export const SessionsLoadError: Story = {
  parameters: {
    mockApi: {
      scenario: "budget-limits",
      overrides: { "/settings/api/budget/sessions": { status: 500, body: { error: { message: "Usage history is unreadable." } } } },
    },
  },
  play: openSessions,
};

/** Nothing has been used yet, so there are no sessions. */
export const SessionsEmpty: Story = {
  parameters: { mockApi: { scenario: "budget-empty" } },
  play: openSessions,
};


// ---- Rules for one model ---------------------------------------------------------

/** Sets the address the Models list's shield links to while a story is on screen, and puts it back. */
function AtAddress({ hash, children }: { hash: string; children: ReactNode }): JSX.Element {
  useEffect(() => {
    window.location.hash = hash;
    return () => {
      window.location.hash = "";
    };
  }, [hash]);
  return <>{children}</>;
}

/** Arriving from a model's shield in the Models list: the rules that apply to it, with a chip that clears. */
export const RulesForModel: Story = {
  parameters: { mockApi: { scenario: "budget-filters" } },
  decorators: [(Story) => <AtAddress hash="#rules/model/claude-haiku-5-5"><Story /></AtAddress>],
};

/** A model only the rule that covers everything applies to. */
export const RulesForModelEmbedding: Story = {
  parameters: { mockApi: { scenario: "budget-filters" } },
  decorators: [(Story) => <AtAddress hash="#rules/model/text-embedding-3-small"><Story /></AtAddress>],
};

/** No rule applies to the model at all: it says so and offers to clear the filter. */
export const RulesForModelNone: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  decorators: [(Story) => <AtAddress hash="#rules/model/text-embedding-3-small"><Story /></AtAddress>],
};
