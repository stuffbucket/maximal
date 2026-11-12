import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { Budget } from "../../../../shell/src/ui/features/budget/Budget";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * The Budget surface: the summary, Limits, Activity and Settings over `/settings/api/budget`
 * and `/settings/api/budget/activity` from the mock sidecar
 * (scripts/ui-harness-budget.ts, a small working budget service over a made-up
 * spend ledger). Every story is a backend state; changes made in a story
 * (adding, editing or deleting a limit, the switch, the unit) go through the
 * same requests the app sends and come back as `budget.changed`.
 */
const meta = {
  title: "Budget/Budget",
  component: Budget,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof Budget>;
export default meta;
type Story = StoryObj<typeof meta>;

const state = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });

/** Limits that are fine, nearly spent and spent, with a week of activity and the provider's allowances. */
export const Limits = state({ scenario: "budget-limits" });
/** Enforcement switched off: the limits are kept and listed, none refuses a request. */
export const EnforcementOff = state({ scenario: "budget-off" });
/** Spend and a provider allowance, but no limits yet: nothing is listed per model, and Add a limit is the way in. */
export const NoLimitsYet = state({ scenario: "budget-no-limits" });
/** First run: no limits, no provider report, nothing spent. */
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
/** The limits load but the spend behind the chart can't: the error sits in Activity, the rest stays usable. */
export const ActivityLoadError = state({
  scenario: "budget-limits",
  overrides: {
    "/settings/api/budget/activity": { status: 500, body: { error: { message: "Usage history is unreadable." } } },
  },
});
/** Activity is slow: the summary and Limits are up while it loads. */
export const ActivityLoading = state({
  scenario: "budget-limits",
  overrides: { "/settings/api/budget/activity": "hang" },
});
/** Changing the switch or unit takes a beat, so the controls disable while it saves. */
export const SlowSave = state({ scenario: "budget-limits", latencyMs: 1200 });

/** The add form, opened from "Add a limit". */
export const AddLimitDialog: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Add a limit" }));
  },
};

/** The edit form for a limit that follows the provider's monthly allowance. */
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

/** Saving a limit the server refuses puts the reason in the dialog. */
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
    await userEvent.click(await canvas.findByRole("button", { name: "Add a limit" }));
    await userEvent.type(await canvas.findByLabelText("Amount"), "2");
    await userEvent.click(await canvas.findByRole("button", { name: "Save limit" }));
  },
};

/** An amount that isn't one: the caption says what to type, the field is focused, and the dialog keeps every value. */
export const AmountProblem: Story = {
  parameters: { mockApi: { scenario: "budget-no-limits" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add a limit" }));
    await userEvent.type(await canvas.findByLabelText("Name"), "My cap");
    await userEvent.type(await canvas.findByLabelText("Amount"), "lots");
    await userEvent.click(await canvas.findByRole("button", { name: "Save limit" }));
  },
};
