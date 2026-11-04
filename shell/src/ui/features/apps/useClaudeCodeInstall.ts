import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiCall,
  type ClaudeCodeInstallStatus,
} from "../../../proxy/client";
import { humanize } from "../api-clients/humanize";

const POLL_MS = 1500;

/**
 * The one-click WinGet install of Claude Code on Windows. Starting it is the
 * user's click; this follows the background install's progress, reads it
 * again after a restart of the Settings window, and calls `onFinished` once
 * it has succeeded so the apps list re-detects Claude Code.
 */
export function useClaudeCodeInstall(
  onFinished: () => Promise<void>,
  enabled: boolean,
): {
  status: ClaudeCodeInstallStatus | null;
  startError: string | null;
  start: () => Promise<void>;
} {
  const [status, setStatus] = useState<ClaudeCodeInstallStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const finishedRef = useRef(onFinished);
  const requestSequence = useRef(0);
  finishedRef.current = onFinished;

  const read = useCallback(async (): Promise<void> => {
    const sequence = ++requestSequence.current;
    const result = await apiCall({
      kind: "claude-code-install-status",
      method: "GET",
      path: "/settings/api/apps/claude-code/install",
    });
    if (result.ok && sequence === requestSequence.current) {
      setStatus(result.data);
    }
  }, []);

  // An install may still be running from before this view mounted.
  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);

  const running = status?.state === "running";
  useEffect(() => {
    if (!enabled || !running) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await read();
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, running, read]);

  const succeeded = status?.state === "succeeded";
  useEffect(() => {
    if (enabled && succeeded) void finishedRef.current();
  }, [enabled, succeeded]);

  const start = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setStartError(null);
    const sequence = ++requestSequence.current;
    const result = await apiCall({
      kind: "claude-code-install-start",
      method: "POST",
      path: "/settings/api/apps/claude-code/install",
      body: { method: "winget" },
    });
    if (sequence !== requestSequence.current) return;
    if (result.ok) setStatus(result.data);
    else setStartError(humanize(result.error));
  }, [enabled]);

  return { status, startError, start };
}
