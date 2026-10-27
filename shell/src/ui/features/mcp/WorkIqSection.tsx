import { useState } from "react";

import type { WorkIqStatus } from "../../../proxy/client";
import { openUrl } from "../../../tauri/shell";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Checkbox } from "../../components/Checkbox";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";
import type { Problem } from "../../problems";

import type { McpMutationResult } from "./useMcp";

const TERMS_URL = "https://github.com/microsoft/work-iq";
const ADMIN_URL = "https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md";
const DOCS_URL =
  "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli";

interface WorkIqSectionProps {
  status: WorkIqStatus;
  onAcceptEula: () => Promise<McpMutationResult>;
  onSignIn: (useBrowserSignIn: boolean) => Promise<McpMutationResult>;
  onCancelSignIn: () => Promise<void>;
}

/** Opens in the system browser; a plain new window outside the app. */
async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function ExternalLink({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Where Work IQ's setup stands on its endpoint card, and the one thing to
 * do next: accept Microsoft's terms, sign in, or ask an admin. Each Work IQ
 * command runs only after the user confirms it in a dialog that names it.
 */
export function WorkIqSection({
  status,
  onAcceptEula,
  onSignIn,
  onCancelSignIn,
}: WorkIqSectionProps): JSX.Element {
  const [eulaOpen, setEulaOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [useBrowser, setUseBrowser] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<Problem | null>(null);

  const offerBrowser = status.macos && !status.browserSignIn;

  const acceptEula = async (): Promise<void> => {
    setWorking(true);
    setFailed(null);
    const result = await onAcceptEula();
    setWorking(false);
    setEulaOpen(false);
    if (!result.ok && result.problem) setFailed(result.problem);
  };

  const signIn = async (): Promise<void> => {
    setWorking(true);
    setFailed(null);
    const result = await onSignIn(offerBrowser && useBrowser);
    setWorking(false);
    setSignInOpen(false);
    if (!result.ok && result.problem) setFailed(result.problem);
  };

  const openSignIn = (): void => {
    setUseBrowser(false);
    setSignInOpen(true);
  };

  const signInButton = (label: string): JSX.Element => (
    <Button size="sm" variant="primary" onClick={openSignIn}>
      {label}
    </Button>
  );

  const lastProblem = status.lastProblem && (
    <details className="callout__details">
      <summary>Details</summary>
      <code>{status.lastProblem}</code>
    </details>
  );

  let body: JSX.Element;
  if (status.signIn === "waiting") {
    body = (
      <Stack proximity="group" align="start">
        <p className="app-card__hint" role="status">
          Waiting for you to finish signing in.
        </p>
        <Button size="sm" onClick={() => void onCancelSignIn()}>
          Cancel sign-in
        </Button>
      </Stack>
    );
  } else if (status.signIn === "restarting") {
    body = (
      <p className="app-card__hint" role="status">
        Signed in. Restarting Work IQ…
      </p>
    );
  } else if (status.state === "not-installed") {
    body = (
      <p className="app-card__hint">
        Work IQ isn't installed where Maximal last found it. Reinstall it, then refresh.
      </p>
    );
  } else if (status.state === "eula-needed") {
    body = (
      <Stack proximity="group" align="start">
        <p className="app-card__hint">
          Work IQ needs you to accept Microsoft's terms before it can run.
        </p>
        <Button size="sm" variant="primary" onClick={() => setEulaOpen(true)}>
          Review terms
        </Button>
      </Stack>
    );
  } else if (status.state === "signin-needed") {
    body = (
      <>
        {status.signIn === "failed" && (
          <Callout tone="error" title="Sign-in didn't finish">
            {lastProblem}
          </Callout>
        )}
        {status.signIn === "timed-out" && (
          <Callout tone="notice" title="Sign-in timed out">
            <p>Maximal stopped waiting after 5 minutes.</p>
          </Callout>
        )}
        <Stack proximity="group" align="start">
          <p className="app-card__hint">Sign in to Work IQ with your Microsoft 365 work account.</p>
          {signInButton("Sign in")}
        </Stack>
      </>
    );
  } else if (status.state === "starting") {
    body = (
      <>
        <p className="app-card__hint" role="status">
          Work IQ is starting…
        </p>
        {status.lastProblem && (
          <p className="app-card__hint">Last message from Work IQ: {status.lastProblem}</p>
        )}
      </>
    );
  } else if (status.state === "consent-needed") {
    body = (
      <Callout
        tone="notice"
        title="Your organization needs to approve Work IQ"
        action={signInButton("Sign in again")}
      >
        <p>
          You're signed in, but Work IQ can't reach your Microsoft 365 data yet. An admin must
          approve Work IQ for your organization, and your account needs a license for it. See the{" "}
          <ExternalLink href={ADMIN_URL}>admin instructions</ExternalLink> and{" "}
          <ExternalLink href={DOCS_URL}>Microsoft's Work IQ guide</ExternalLink>.
        </p>
        {lastProblem}
      </Callout>
    );
  } else {
    body = (
      <p className="app-card__hint" role="status">
        Signed in. Work IQ is ready.
      </p>
    );
  }

  return (
    <>
      {body}

      {failed && <ProblemCallout problem={failed} />}

      <ConfirmDialog
        open={eulaOpen}
        title="Accept the Work IQ terms?"
        body={
          <>
            <p>
              Maximal will run <code className="mono">workiq accept-eula</code>, which records that
              you accept Microsoft's terms for Work IQ.
            </p>
            <p>
              <ExternalLink href={TERMS_URL}>Read the terms</ExternalLink>
            </p>
          </>
        }
        confirmLabel="Accept terms"
        busy={working}
        onConfirm={acceptEula}
        onCancel={() => setEulaOpen(false)}
      />

      <ConfirmDialog
        open={signInOpen}
        title="Sign in to Work IQ?"
        body={
          <>
            <p>
              Maximal will run <code className="mono">workiq auth login</code>, which opens a
              Microsoft sign-in page.
            </p>
            {offerBrowser && (
              <>
                <p>
                  On macOS, Work IQ's built-in sign-in often fails when an app starts it. Browser
                  sign-in avoids that.
                </p>
                <Checkbox
                  label="Use browser sign-in"
                  hideLabel={false}
                  checked={useBrowser}
                  onCheckedChange={setUseBrowser}
                />
                {useBrowser && (
                  <p>
                    Maximal will first run{" "}
                    <code className="mono">workiq config set disableBrokeredAuth=true</code>.
                  </p>
                )}
              </>
            )}
            {status.macos && (
              <p>
                macOS may ask for your Mac password so Work IQ can save your sign-in to your
                keychain. Choose Always Allow.
              </p>
            )}
          </>
        }
        confirmLabel="Sign in"
        busy={working}
        onConfirm={signIn}
        onCancel={() => setSignInOpen(false)}
      />
    </>
  );
}
