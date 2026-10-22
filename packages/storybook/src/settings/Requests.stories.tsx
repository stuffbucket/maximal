import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within } from "storybook/test";

import type { PendingRequest } from "../../../../shell/src/proxy/client";
import { RequestDialog } from "../../../../shell/src/ui/features/requests/RequestDialog";
import { RequestsPanel } from "../../../../shell/src/ui/features/requests/RequestsPanel";
import type { AnswerOutcome } from "../../../../shell/src/ui/features/requests/useRequests";
import type { MockApiParameters } from "../mock/fetch-mock";

const inMinutes = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

/** A form using every field kind Maximal shows. */
const form: PendingRequest = {
  id: "elicit-form",
  endpointId: "workiq",
  label: "Work IQ",
  toolName: "get_debug_link",
  mode: "form",
  message:
    "Create a shareable debug link for this conversation? Anyone with the link can see the conversation's diagnostic details for 7 days.",
  fields: [
    { name: "confirmed", kind: "boolean", title: "Create the link", required: true },
    {
      name: "audience",
      kind: "enum",
      title: "Who can open it",
      required: true,
      options: [
        { value: "org", label: "People in my organization" },
        { value: "me", label: "Only me" },
      ],
    },
    {
      name: "days",
      kind: "integer",
      title: "Days it stays open",
      description: "Between 1 and 30.",
      required: false,
      minimum: 1,
      maximum: 30,
    },
    { name: "email", kind: "string", title: "Send it to", format: "email", required: false },
    { name: "note", kind: "string", title: "Note for support", required: false, maxLength: 200 },
  ],
  receivedAt: inMinutes(-1),
  expiresAt: inMinutes(4),
};

const link: PendingRequest = {
  id: "elicit-url",
  endpointId: "workiq",
  label: "Work IQ",
  mode: "url",
  message: "Sign in to Microsoft 365 to let Work IQ read your calendar.",
  fields: [],
  url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=example",
  urlHost: "login.microsoftonline.com",
  receivedAt: inMinutes(0),
  expiresAt: inMinutes(5),
};

const meta = {
  title: "Settings/Requests",
  component: RequestDialog,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  args: {
    request: form,
    onAnswer: fn(async (): Promise<AnswerOutcome> => ({ ok: true })),
    onClose: fn(),
  },
} satisfies Meta<typeof RequestDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- RequestDialog -----------------------------------------------------------

/** A form: checkbox, choice, whole number, email and free text. */
export const DialogForm: Story = {};
/** A link: shows where it goes; "Open in browser" answers and opens it. */
export const DialogLink: Story = { args: { request: link } };
/** Sending without the required fields marks them; nothing is sent. */
export const DialogRequired: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Send" }));
  },
};
/** The server's form rejected a value: the message sits under its field. */
export const DialogFieldError: Story = {
  args: {
    request: { ...form, fields: form.fields.filter((field) => field.name === "email") },
    onAnswer: fn(
      async (): Promise<AnswerOutcome> => ({
        ok: false,
        gone: false,
        fieldErrors: { email: "must be an email address" },
      }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/Send it to/u), "not-an-address");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
  },
};
/** Answered from somewhere else (or expired) just as this one was sent. */
export const DialogAnsweredElsewhere: Story = {
  args: {
    request: link,
    onAnswer: fn(async (): Promise<AnswerOutcome> => ({ ok: false, gone: true })),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Decline" }));
  },
};
/** It stopped waiting while open: only Close is left. */
export const DialogNoLongerWaiting: Story = { args: { request: null } };

// ---- RequestsPanel -----------------------------------------------------------

const panel = (mockApi: MockApiParameters): Story => ({
  render: () => <RequestsPanel />,
  parameters: { mockApi },
});

/** Two waiting: a form and a link. */
export const Panel = panel({ scenario: "requests-waiting" });
/** Nothing waiting. */
export const PanelEmpty = panel({ scenario: "signed-in" });
export const PanelLoading = panel({ overrides: { "/settings/api/requests": "hang" } });
/** Maximal isn't answering. */
export const PanelUnreachable = panel({ overrides: { "/settings/api/requests": "offline" } });
