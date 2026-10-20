import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { AnswerOutcome } from "./useRequests";
import type {
  PendingRequest,
  PendingRequestAnswer,
  PendingRequestField,
} from "../../../proxy/client";
import { openUrl } from "../../../tauri/shell";
import { Checkbox } from "../../components/Checkbox";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

type Value = string | boolean;
type Content = NonNullable<PendingRequestAnswer["content"]>;

interface RequestDialogProps {
  /** The request being answered; null once it stopped waiting. */
  request: PendingRequest | null;
  onAnswer: (answer: PendingRequestAnswer) => Promise<AnswerOutcome>;
  /** Close without answering; the request keeps waiting. */
  onClose: () => void;
}

const INPUT_TYPE: Record<NonNullable<PendingRequestField["format"]>, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

function initialValues(fields: Array<PendingRequestField>): Record<string, Value> {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.kind === "boolean" ? field.default === true : String(field.default ?? ""),
    ]),
  );
}

/** The answer's content, or the fields that need fixing first. */
function collect(
  fields: Array<PendingRequestField>,
  values: Record<string, Value>,
): { content: Content } | { errors: Record<string, string> } {
  const content: Content = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") {
      content[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      if (field.required) errors[field.name] = "Required";
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const number = Number(text);
      if (!Number.isFinite(number)) errors[field.name] = "Enter a number";
      else if (field.kind === "integer" && !Number.isInteger(number)) {
        errors[field.name] = "Enter a whole number";
      } else content[field.name] = number;
      continue;
    }
    content[field.name] = text;
  }
  return Object.keys(errors).length > 0 ? { errors } : { content };
}

/** Plain browser fallback (ui:harness, Storybook) when Tauri isn't there. */
async function openInBrowser(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function Field({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: PendingRequestField;
  value: Value | undefined;
  error?: string;
  disabled: boolean;
  onChange: (value: Value) => void;
}): JSX.Element {
  const id = useId();
  const label = field.title ?? field.name;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [field.description ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") ||
    undefined;

  if (field.kind === "boolean") {
    return (
      <div className="request-field">
        <label className="request-field__check">
          <Checkbox
            checked={value === true}
            onCheckedChange={onChange}
            disabled={disabled}
            aria-describedby={describedBy}
          />
          <span className="request-field__label">{label}</span>
        </label>
        {field.description && (
          <p className="form__hint" id={hintId}>
            {field.description}
          </p>
        )}
        {error && (
          <p className="state__caption state__caption--error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    disabled,
    required: field.required,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div className="request-field">
      <label className="request-field__label" htmlFor={id}>
        {label}
        {!field.required && <span className="request-field__optional"> (optional)</span>}
      </label>
      {field.kind === "enum" ? (
        <select
          {...common}
          className="select"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        >
          {(!field.required || text === "") && <option value="">Choose…</option>}
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          className="input"
          type={
            field.kind === "string" ? (field.format ? INPUT_TYPE[field.format] : "text") : "number"
          }
          inputMode={field.kind === "integer" ? "numeric" : undefined}
          step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined}
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description && (
        <p className="form__hint" id={hintId}>
          {field.description}
        </p>
      )}
      {error && (
        <p className="state__caption state__caption--error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Answer one MCP server's request: fill in its form, or open its link.
 * Native <dialog> for the top layer, focus trap and Escape. Closing it
 * (Escape, Close, the backdrop) doesn't answer: the request keeps waiting
 * until it's answered or expires. Everything the server sent is shown as
 * plain text and labelled as coming from it.
 */
export function RequestDialog({ request, onAnswer, onClose }: RequestDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const [shown] = useState(request);
  const [values, setValues] = useState(() => initialValues(shown?.fields ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        /* already open under strict-mode double effects */
      }
    }
  }, []);

  // It stopped waiting while open (expired, withdrawn, answered elsewhere).
  useEffect(() => {
    if (request === null) setGone(true);
  }, [request]);

  const close = (): void => {
    if (!busy) onClose();
  };

  const send = async (answer: PendingRequestAnswer): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const outcome = await onAnswer(answer);
    setBusy(false);
    if (outcome.ok) return true;
    if (outcome.gone) setGone(true);
    else if ("fieldErrors" in outcome) setErrors(outcome.fieldErrors);
    else setProblem(outcome.problem);
    return false;
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!shown || busy) return;
    if (shown.mode === "url") {
      if (shown.url && (await send({ action: "accept" }))) {
        await openInBrowser(shown.url);
        onClose();
      }
      return;
    }
    const collected = collect(shown.fields, values);
    if ("errors" in collected) {
      setErrors(collected.errors);
      return;
    }
    setErrors({});
    if (await send({ action: "accept", content: collected.content })) onClose();
  };

  const decline = async (): Promise<void> => {
    if (await send({ action: "decline" })) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog request-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
    >
      <form className="confirm-dialog__panel" onSubmit={(event) => void submit(event)} noValidate>
        <h2 className="confirm-dialog__title" id={titleId}>
          {shown ? `${shown.label} needs your answer` : "Request"}
        </h2>

        {gone || !shown ? (
          <p className="confirm-dialog__body">
            This request is no longer waiting. It may have timed out, or the app that asked has
            moved on.
          </p>
        ) : (
          <>
            {problem && <ProblemCallout problem={problem} />}
            <div className="request-dialog__from">
              <p className="request-dialog__source">
                {shown.toolName
                  ? `${shown.label} says, while running ${shown.toolName}:`
                  : `${shown.label} says:`}
              </p>
              <p className="request-dialog__message">{shown.message}</p>
            </div>

            {shown.mode === "url" ? (
              <div className="request-field">
                <p className="request-field__label">
                  {shown.urlHost ? `Opens ${shown.urlHost} in your browser` : "Opens a link in your browser"}
                </p>
                <p className="request-dialog__url">{shown.url}</p>
              </div>
            ) : (
              shown.fields.map((field) => (
                <Field
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  error={errors[field.name]}
                  disabled={busy}
                  onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
                />
              ))
            )}
          </>
        )}

        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
            Close
          </button>
          {!gone && shown && (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void decline()}
                disabled={busy}
              >
                Decline
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {busy ? "Sending…" : shown.mode === "url" ? "Open in browser" : "Send"}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
