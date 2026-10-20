import { useEffect, useRef, useState } from "react";

import { RequestDialog } from "./RequestDialog";
import { useRequests } from "./useRequests";
import type { PendingRequest } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

/** How often "time left" is redrawn. */
const TICK_MS = 15_000;

function timeLeft(expiresAt: string, now: number): string {
  const minutes = Math.floor((Date.parse(expiresAt) - now) / 60_000);
  if (minutes < 1) return "Expires in under a minute";
  return minutes === 1 ? "Expires in 1 minute" : `Expires in ${minutes} minutes`;
}

function RequestCard({
  request,
  now,
  onAnswer,
}: {
  request: PendingRequest;
  now: number;
  onAnswer: (opener: HTMLButtonElement) => void;
}): JSX.Element {
  return (
    <article className="card request-card" aria-label={`${request.label} needs your answer`}>
      <div className="card__head">
        <div className="card__main">
          <h3 className="card__title">{request.label}</h3>
          <p className="card__hint request-card__meta">
            {request.toolName ? `While running ${request.toolName}. ` : ""}
            {timeLeft(request.expiresAt, now)}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={(event) => onAnswer(event.currentTarget)}
        >
          {request.mode === "url" ? "Review link…" : "Answer…"}
        </Button>
      </div>
      <p className="request-card__message">{request.message}</p>
    </article>
  );
}

/**
 * Settings → Requests: MCP servers' questions that the app using them
 * couldn't show, waiting for an answer. Nothing here opens or takes focus
 * by itself; a notification and the tray say when one arrives.
 */
export function RequestsPanel(): JSX.Element {
  const { requests, isLoading, problem, refresh, answer } = useRequests();
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const openerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const open = openId === null ? undefined : requests.find((request) => request.id === openId);

  // Back to the button that opened the dialog once it's gone: while the
  // modal is up everything outside it is inert, so focusing earlier fails.
  useEffect(() => {
    if (openId === null && openerRef.current?.isConnected) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, [openId]);
  const closeDialog = (): void => setOpenId(null);

  return (
    <Stack proximity="region" className="requests-panel" aria-busy={isLoading}>
      {problem && <ProblemCallout problem={problem} onRestarted={() => void refresh()} />}

      {isLoading && requests.length === 0 ? (
        <p className="state__caption">Loading requests…</p>
      ) : requests.length === 0 ? (
        !problem && (
          <EmptyState title="Nothing is waiting for you">
            When an MCP server asks you something that the app using it can't show, the question
            appears here, and Maximal lets you know.
          </EmptyState>
        )
      ) : (
        <Stack proximity="group">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              now={now}
              onAnswer={(opener) => {
                openerRef.current = opener;
                setOpenId(request.id);
              }}
            />
          ))}
        </Stack>
      )}

      {openId !== null && (
        <RequestDialog
          key={openId}
          request={open ?? null}
          onAnswer={(body) => answer(openId, body)}
          onClose={closeDialog}
        />
      )}
    </Stack>
  );
}
