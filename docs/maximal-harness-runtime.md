# Maximal Harness Runtime

Status: **PROPOSED ARCHITECTURE — awareness first, orchestration later**

This document defines a local runtime for Claude Code, Codex, and GitHub
Copilot CLI. It is based on version-pinned, adversarially verified provider
surfaces as of 2026-08-05.

The design has one non-negotiable truth rule:

> Terminal bytes are presentation. Provider-supported structured channels are
> semantic evidence. Neither is silently promoted into authority it does not
> have.

A terminal may show that a tool ran, an approval prompt is visible, or a turn
looks complete. Maximal may render that text, preserve it, and let the user act
inside the terminal. It must never turn scraped terminal text into an approval,
tool event, usage record, diff, or completion signal.

## 1. Product goal

A user can create a harness slot for a project, keep its interactive CLI alive
in a dedicated PTY rendered by Ghostty, bring it forward or dismiss it without
stopping the process, and see the richest real-time structured awareness that
the installed harness officially supports.

The first product is an **awareness console**:

- Which projects and harness sessions exist?
- Which runs are active, idle, blocked, interrupted, failed, or disconnected?
- Which run needs attention?
- What committed messages, tool calls, diffs, tasks, and usage did the
  structured provider report?
- What is live but provisional?
- What was reconstructed after reconnect?
- What can Maximal actually control on this exact harness version?

It is not initially a universal agent orchestrator. Cross-provider queues,
automatic delegation, policy engines, and unattended approval are later layers
that must be earned by adapter conformance tests.

## 2. Hard constraints

1. **One durable PTY per harness slot.** The PTY remains mounted while its tab or
   window is dismissed. Dismissal changes presentation, not process lifetime.
2. **Ghostty renders; the main process owns processes.** The sandboxed renderer
   never spawns a CLI, reads credentials, opens provider sockets, or resolves an
   approval.
3. **No terminal scraping for semantics.** ANSI output, screen cells, OSC title,
   and status-line data are observational only.
4. **Structured awareness only where officially supported.** Unknown or
   experimental surfaces are feature-gated per installed version.
5. **No false hybrid.** If a provider cannot attach a structured controller to
   the same interactive TUI process or session, Maximal exposes separate run
   modes rather than pretending they are one run.
6. **Raw evidence is retained.** Normalization never destroys the original
   provider envelope or PTY transcript.
7. **Reconnect means reconcile, not replay.** A provider snapshot may recover
   committed state; it does not recreate lost deltas, background processes, or
   ephemeral prompts.
8. **Cancellation is graded.** Semantic interrupt, graceful process signal, and
   force kill are distinct controls with distinct outcomes.
9. **Approvals fail closed.** Only an active structured request may be resolved
   through Maximal chrome. Transport ambiguity, stale requests, unknown
   variants, and malformed payloads cannot become approval.
10. **Capabilities are evidence, not brand assumptions.** Every session records
    harness version, adapter version, launch mode, negotiated capabilities, and
    configuration provenance.

## 3. The paired-surface model

A `HarnessSlot` always owns a presentation lane and may own a semantic lane.
The two lanes are correlated only to the level the provider supports.

```text
HarnessSlot
├── terminal lane
│   ├── PTY process
│   ├── Ghostty emulator
│   ├── byte transcript
│   └── user keystrokes / resize / foreground / dismiss
└── semantic lane (optional)
    ├── provider SDK, app server, or protocol connection
    ├── raw structured envelopes
    ├── normalized events and snapshots
    └── supported controls and approval requests
```

### 3.1 Correlation modes

| Mode | Meaning |
| --- | --- |
| `same-process` | Structured events and PTY refer to the same process. None of the first three adapters can promise this generally. |
| `same-provider-session` | Two processes attach to the same provider session/thread. Codex app-server plus `codex --remote` supports this. |
| `exclusive-owners` | The PTY TUI and structured SDK can resume the same durable session, but not concurrently. Copilot supports only a tested idle-point handoff. |
| `separate-runs` | PTY and structured controller are independent runs under one project. This is the safe Claude Code model. |
| `terminal-only` | No trustworthy structured lane is active. |

The UI must display the correlation mode. It must not merge two transcripts as
one conversation when the mode is `separate-runs`.

### 3.2 Provider-specific consequence

- **Codex:** one app-server daemon can back both Electron and a TUI connected
  with `--remote unix://… resume <threadId>`. This is the first true
  same-provider-session dual surface.
- **Claude Code:** an Agent SDK `Query` cannot attach to an arbitrary interactive
  Claude Code PTY. Offer `terminal` mode and `structured` mode as separate runs.
  In structured mode the slot still has a PTY surface for an explicitly labeled
  companion shell or diagnostics, not a second controller for the SDK session.
- **Copilot:** the SDK is the rich controller, ACP is a narrower preview adapter,
  and the TUI is a separate owner. Concurrent access to one persisted SDK
  session is undefined. A TUI handoff is disabled until idle/disconnect/resume
  is proven for the pinned version.

## 4. Repository and process boundaries

This follows `docs/maximal-core-integration.md`: the Electron shell stays
generic, the Maximal client owns product semantics, and maximal-core remains an
optional headless service.

### 4.1 `@stuffbucket/maximal-electron`: generic desktop host

Owns reusable operating-system and renderer primitives:

- PTY spawn, write, resize, signal, exit, and bounded byte journaling.
- Ghostty terminal lifecycle and persistent mounted views.
- Generic process supervision and child-process containment.
- Generic local Unix-socket and stdio transport helpers.
- Typed, allowlisted IPC and sender validation.
- Window/tab foreground, dismiss, notification, and dock-badge primitives.
- Secret-safe log sinks and generic application data directories.
- Build and packaging support for native PTY dependencies.

It must not contain:

- provider names, SDKs, event mappings, or version matrices;
- Maximal's `Project`, `HarnessSession`, `Run`, approval, or usage model;
- policy deciding which provider tool is dangerous;
- maximal-core process names or endpoints.

The current `src/main/native/pty.ts` is the starting primitive, but the runtime
will need spawn arguments, environment allowlisting, process-group identity,
explicit signals, retained sessions independent of React mount state, and a
byte-journal sink. `TerminalView` must stop owning PTY death through component
cleanup; tab close and process stop become separate product actions.

### 4.2 Maximal client: product runtime and adapters

Owns:

- projects, harness slots, sessions, runs, events, approvals, tool calls, diffs,
  tasks, usage, attention state, and UI reducers;
- provider adapters and their exact-version conformance fixtures;
- capability negotiation and launch profiles;
- normalized SQLite persistence and encrypted/redacted raw evidence;
- approval policy, interaction ownership, and cancellation escalation;
- reconnect, snapshot reconciliation, and degraded-state UX;
- provider-specific labels and honest limitations.

Provider SDKs belong in the Electron main process or a dedicated unsandboxed
utility process. They never cross into the renderer. The renderer receives only
Maximal-owned, runtime-validated IPC projections.

### 4.3 `@stuffbucket/maximal-core`: optional, not required for the PoC

The existing proxy core is not the desktop harness broker. Do not make the first
implementation depend on it.

A later optional core module may own platform-neutral pieces when there is a
real second consumer:

- normalized schema definitions;
- append-only event persistence and migrations;
- reducer logic and snapshot reconciliation;
- capability vocabulary;
- transcript export and redaction.

PTYs, Electron IPC, Ghostty, desktop notifications, local provider credentials,
and interactive approvals remain desktop concerns.

## 5. Durable domain model

Provider IDs are opaque external identifiers. Maximal creates its own UUIDs and
stores provider IDs separately. A session is durable provider history; a run is
one active or completed execution attempt; a process is an operating-system
lifetime. These must not be collapsed.

```text
Project 1 ── * HarnessSlot 1 ── * HarnessSession 1 ── * Run
                                      │                    │
                                      │                    ├── Event
                                      │                    ├── ToolCall
                                      │                    ├── InteractionRequest
                                      │                    ├── Diff
                                      │                    └── UsageSample
                                      └── RawTranscript / ProviderCursor
```

### 5.1 Required records

- **Project:** canonical local root, repository identity when known, trust
  profile, and per-project provider configuration.
- **HarnessSlot:** provider, launch profile, PTY identity, foreground/dismissed
  state, and current semantic attachment.
- **HarnessSession:** durable provider conversation/thread identity and launch
  manifest. It can outlive every local process.
- **Run:** one user turn, query, Codex turn, Copilot prompt, or terminal-owned
  activity interval. `Run` may be partially derived where the provider lacks a
  turn concept; provenance records that fact.
- **Event:** normalized observation referencing raw evidence.
- **InteractionRequest:** approval, question, elicitation, authentication, or
  other human gate. It has a durable Maximal lifecycle but remains subordinate
  to provider liveness.
- **ToolCall:** requested, active, completed, failed, denied, interrupted, or
  unknown. Provider final state wins over adapter inference.
- **Diff:** provider-reported or locally computed patch with explicit
  provenance. Terminal-rendered diffs are never normalized.
- **UsageSample:** provider-reported token/accounting values with estimate and
  authority labels.
- **RawRecord:** immutable provider envelope or terminal chunk, content-addressed
  when large, with redaction metadata.

## 6. Exact shared TypeScript contract

These are Maximal-owned application types. They do not impersonate provider SDK
types. Each adapter validates provider payloads, preserves the original, and
then emits these projections.

```ts
export type HarnessKind = 'claude-code' | 'codex' | 'copilot';
export type LaunchMode = 'terminal' | 'structured' | 'acp' | 'one-shot';
export type CorrelationMode =
  | 'same-process'
  | 'same-provider-session'
  | 'exclusive-owners'
  | 'separate-runs'
  | 'terminal-only';

export type Stability = 'stable' | 'preview' | 'experimental' | 'internal';
export type Provenance =
  | 'provider-authoritative'
  | 'provider-ephemeral'
  | 'adapter-derived'
  | 'host-observed'
  | 'pty-presentation';

export interface HarnessVersion {
  executablePath: string;
  executableVersion: string;
  adapterVersion: string;
  sdkVersion?: string;
  protocolVersion?: string;
  schemaRevision: string;
}

export interface Capability<TDetails = unknown> {
  state: 'supported' | 'unsupported' | 'unknown';
  stability: Stability;
  evidence: 'negotiated' | 'probed' | 'version-fixture' | 'configured';
  details?: TDetails;
}

export interface HarnessCapabilities {
  terminal: Capability<{ persistent: boolean }>;
  structuredEvents: Capability<{ deltas: boolean; snapshots: boolean }>;
  committedTranscript: Capability;
  rawTranscript: Capability;
  resume: Capability<{ restoresProcessState: false }>;
  fork: Capability;
  reconnect: Capability<{
    strategy: 'snapshot' | 'history-plus-live' | 'resume-only' | 'none';
    exactReplay: boolean;
  }>;
  interruptTurn: Capability;
  gracefulClose: Capability;
  forceKill: Capability;
  approvals: Capability<{
    reconstructable: 'all' | 'permissions-only' | 'pending-only' | 'none';
    ownership: 'exclusive' | 'first-responder' | 'callback' | 'none';
  }>;
  toolCalls: Capability;
  diffs: Capability;
  usage: Capability<{ billingAuthority: 'estimate' | 'provider' | 'none' }>;
  tasks: Capability;
  subagents: Capability<{
    visibility:
      | 'none'
      | 'activity-only'
      | 'parent-tool-only'
      | 'child-session-metadata'
      | 'child-history'
      | 'live-child-control';
  }>;
  steer: Capability;
}

export interface CapabilityReport {
  harness: HarnessKind;
  mode: LaunchMode;
  correlation: CorrelationMode;
  version: HarnessVersion;
  capabilities: HarnessCapabilities;
  warnings: string[];
  negotiatedAt: string;
}

export interface LaunchManifest {
  projectId: string;
  cwd: string;
  mode: LaunchMode;
  executablePath: string;
  args: string[];
  environmentKeys: string[];
  configRefs: string[];
  workingTreeIdentity?: string;
  requestedModel?: string;
  requestedPermissionMode?: string;
  providerOptions: Readonly<Record<string, unknown>>;
}

export interface ProviderRef {
  namespace: string;
  id: string;
  parentId?: string;
  requestId?: string;
}

export interface RawRef {
  id: string;
  mediaType: 'application/json' | 'application/x-ndjson' | 'text/x-pty';
  sha256: string;
  redaction: 'none' | 'automatic' | 'manual';
}

export interface NormalizedEvent<TType extends string, TPayload> {
  schemaVersion: 1;
  eventId: string;
  projectId: string;
  harnessSessionId: string;
  runId?: string;
  streamId: string;
  epoch: string;
  sequence: number;
  observedAt: string;
  providerOccurredAt?: string;
  harness: HarnessKind;
  sourceType: string;
  type: TType;
  provenance: Provenance;
  providerRef?: ProviderRef;
  rawRef: RawRef;
  payload: TPayload;
}
```

`sequence` is assigned transactionally by Maximal per `(streamId, epoch)`. It is
observation order only. It is not presented as provider order, a provider replay
cursor, or proof that no upstream event was lost.

### 6.1 Normalized event union

Keep the union intentionally small. Unknown provider events are stored raw and
emitted as diagnostics rather than guessed into a known semantic event.

```ts
export type HarnessEvent =
  | NormalizedEvent<'connection.state', ConnectionState>
  | NormalizedEvent<'session.snapshot', SessionSnapshot>
  | NormalizedEvent<'run.state', RunState>
  | NormalizedEvent<'message.delta', MessageDelta>
  | NormalizedEvent<'message.committed', CommittedMessage>
  | NormalizedEvent<'tool.state', ToolState>
  | NormalizedEvent<'interaction.state', InteractionState>
  | NormalizedEvent<'diff.committed', CommittedDiff>
  | NormalizedEvent<'task.state', TaskState>
  | NormalizedEvent<'usage.sample', UsageSample>
  | NormalizedEvent<'process.state', ProcessState>
  | NormalizedEvent<'diagnostic', DiagnosticEvent>;

export interface ConnectionState {
  state: 'connecting' | 'live' | 'reconciling' | 'degraded' | 'closed';
  reason?: 'transport' | 'overloaded' | 'version' | 'protocol' | 'process-exit';
  gap: 'none' | 'possible' | 'confirmed';
}

export interface SessionSnapshot {
  providerSessionId?: string;
  title?: string;
  state: 'new' | 'active' | 'idle' | 'blocked' | 'closed' | 'unknown';
  activeRunIds: string[];
  pendingInteractionIds: string[];
  reconstruction: 'provider-snapshot' | 'provider-history' | 'local-only';
}

export interface RunState {
  state:
    | 'queued'
    | 'running'
    | 'blocked'
    | 'interrupting'
    | 'interrupted'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  reason?: string;
  terminal: boolean;
}

export interface MessageDelta {
  messageId: string;
  role: 'assistant' | 'user' | 'system' | 'tool';
  text: string;
  parentToolCallId?: string;
  disposable: true;
}

export interface CommittedMessage {
  messageId: string;
  role: 'assistant' | 'user' | 'system' | 'tool';
  blocks: unknown[];
  parentToolCallId?: string;
  replacesDelta: boolean;
}

export interface ToolState {
  toolCallId: string;
  name: string;
  state:
    | 'requested'
    | 'running'
    | 'completed'
    | 'failed'
    | 'denied'
    | 'interrupted'
    | 'unknown';
  input?: unknown;
  output?: unknown;
  error?: string;
  parentToolCallId?: string;
  agentId?: string;
}

export type InteractionKind =
  | 'tool-approval'
  | 'file-approval'
  | 'permissions'
  | 'question'
  | 'elicitation'
  | 'authentication'
  | 'plan-exit'
  | 'unknown';

export interface InteractionState {
  interactionId: string;
  providerRequestId?: string;
  kind: InteractionKind;
  state: 'pending' | 'responding' | 'resolved' | 'cancelled' | 'stale';
  prompt?: string;
  options: ReadonlyArray<{
    id: string;
    label: string;
    effect: 'allow' | 'deny' | 'answer' | 'cancel' | 'provider-specific';
    providerValue: unknown;
  }>;
  requestedScope?: unknown;
  grantedScope?: unknown;
  resolution?: unknown;
  expiresWhenDisconnected: boolean;
}

export interface CommittedDiff {
  diffId: string;
  format: 'unified' | 'provider-patch' | 'file-list';
  content: string;
  authority: 'provider' | 'host-computed';
  baseRevision?: string;
}

export interface UsageSample {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
  model?: string;
  scope: 'request' | 'turn' | 'session' | 'model';
  authority: 'provider-reported' | 'client-estimate' | 'host-estimate';
}
```

### 6.2 Adapter interfaces

```ts
export interface HarnessAdapter {
  readonly kind: HarnessKind;

  probe(input: ProbeInput, signal: AbortSignal): Promise<CapabilityReport>;

  create(input: CreateSessionInput, sink: AdapterSink): Promise<AdapterSession>;

  resume(input: ResumeSessionInput, sink: AdapterSink): Promise<AdapterSession>;
}

export interface ProbeInput {
  executablePath: string;
  cwd: string;
  mode: LaunchMode;
  environment: Readonly<Record<string, string>>;
}

export interface CreateSessionInput {
  localSessionId: string;
  manifest: LaunchManifest;
  capabilityReport: CapabilityReport;
}

export interface ResumeSessionInput extends CreateSessionInput {
  providerSessionId: string;
  lastLocalSnapshot?: LocalSnapshot;
}

export interface AdapterSink {
  appendRaw(record: RawInput): Promise<RawRef>;
  emit(event: HarnessEvent): Promise<void>;
  checkpoint(snapshot: ProviderCheckpoint): Promise<void>;
  setPendingInteraction(request: PendingInteraction): Promise<void>;
  clearPendingInteraction(interactionId: string, reason: string): Promise<void>;
}

export interface AdapterSession {
  readonly localSessionId: string;
  readonly providerSessionId: string | undefined;
  readonly capabilities: HarnessCapabilities;

  startRun(input: StartRunInput): Promise<RunHandle>;
  reconcile(reason: ReconcileReason): Promise<ReconcileResult>;
  respond(input: InteractionResponse): Promise<InteractionResponseResult>;
  close(input: CloseInput): Promise<void>;
}

export interface RunHandle {
  readonly runId: string;
  send(input: UserInput): Promise<void>;
  steer?(input: UserInput): Promise<void>;
  interrupt(input: InterruptInput): Promise<InterruptResult>;
  stopTask?(taskId: string): Promise<void>;
  waitForTerminal(signal?: AbortSignal): Promise<RunTerminalState>;
}

export type ReconcileReason =
  | 'initial-connect'
  | 'transport-reconnect'
  | 'slow-consumer'
  | 'renderer-reload'
  | 'app-restart'
  | 'manual-refresh';

export interface ReconcileResult {
  snapshot: SessionSnapshot;
  recoveredProviderRefs: ProviderRef[];
  lostEphemeralState: boolean;
  possibleGap: boolean;
}

export interface InteractionResponse {
  interactionId: string;
  optionId: string;
  value?: unknown;
  expectedProviderRequestId?: string;
  expectedState: 'pending';
}

export interface InteractionResponseResult {
  state: 'accepted' | 'already-resolved' | 'stale' | 'rejected';
  providerResolution?: unknown;
}
```

Rules enforced above the adapters:

- `respond` is compare-and-set against a locally pending request.
- The adapter rechecks provider liveness where the provider offers a pending
  request API.
- Unknown interaction types have no affirmative option.
- The renderer never supplies provider-native decision objects directly. It
  chooses an adapter-issued opaque option ID.
- An adapter cannot advertise a control whose capability is not `supported`.

### 6.3 Generic PTY interface

This belongs in maximal-electron and contains no harness semantics.

```ts
export interface PtyHost {
  spawn(input: PtySpawn): Promise<PtyHandle>;
  attach(id: string, sink: PtySink): Promise<PtyHandle>;
}

export interface PtySpawn {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  environment: Readonly<Record<string, string>>;
  containment: 'process-group' | 'job-object';
}

export interface PtyHandle {
  readonly id: string;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  signal(signal: 'interrupt' | 'terminate' | 'kill'): Promise<void>;
  detachView(): Promise<void>;
  close(): Promise<void>;
}

export interface PtySink {
  onBytes(id: string, bytes: Uint8Array): void;
  onExit(id: string, exitCode: number | null, signal?: string): void;
}
```

Use bytes end to end. Do not assume provider output is valid UTF-8 before the
terminal emulator sees it. Journal chunks with local sequence and monotonic
arrival time; recording user input is opt-in because it can contain secrets.

## 7. Capability matrix

Legend: **S** stable/supported, **P** preview, **E** experimental, **O**
observational only, **N** unavailable or unsafe to promise. Exact support is
still negotiated at runtime.

| Capability | Claude terminal | Claude Agent SDK | Codex TUI + app-server | Codex `exec --json` | Copilot terminal | Copilot SDK | Copilot ACP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ghostty PTY | S | companion only | S | companion only | S | companion only | companion only |
| Same live provider session in PTY + structured UI | N | N | S | N | N | N | N |
| Structured committed transcript | N/O hooks | S | S | S, narrow | O | S | P |
| Token/text deltas | N | S, main session | S, lossy | S, narrow | N | S, ephemeral | P/negotiated |
| Structured tool lifecycle | N/O hooks | S | S | partial | N/O hooks | S | P/negotiated |
| Structured approvals | N | S callback | S, first responder | N | N | S callback | P |
| Exclusive approval ownership with TUI visible | N | separate run | N | N | N | exclusive SDK owner | only if sole owner |
| Resume conversation | S command | S | S | S one-shot | S command | S | capability-gated |
| Restore background processes | N | N | N | N | N | N | N |
| Reconnect recovery | terminal survives | resume/history | snapshot + resume | restart/resume | terminal survives | persisted events + resume | capability-gated |
| Semantic interrupt | keystroke only | S `interrupt` | S `turn/interrupt` | process signal | keystroke only | S `abort` | `session/cancel` |
| Task/background stop | terminal controls | S where task ID exists | E for background terminal | N | terminal controls | limited/E | negotiated |
| Steering | keystrokes | streaming input | S `turn/steer` | N | keystrokes | S immediate/enqueue | prompt/cancel only |
| Structured diff | N | tool/result dependent | S item/final patch | partial | N | tool event dependent | tool-update dependent |
| Subagent visibility | O hooks | parent tool + complete forwarded text; no token deltas | rich, partly E | partial | O | `agentId` lifecycle; control E | no standard graph |
| Usage | status/result estimate | aggregate estimate | provider fields | result fields | status/OTel O | provider events | extension/negotiated |
| Billing-authoritative cost | N | N | N | N | N | N | N |
| Exact replay cursor | N | N | N | N | N | N | N |

### 7.1 What “companion only” means

The slot still owns a PTY, satisfying the product's persistent terminal model,
but the structured run is not running inside that PTY. The terminal is labeled
**Companion shell — not the structured run**. It can inspect the project and run
human commands, but its text is not merged into the structured transcript.

If this UX is unacceptable, the product must choose terminal-owned mode and
accept degraded awareness. There is no architecture that can manufacture a
same-process structured channel where the provider does not expose one.

## 8. Adapter designs

### 8.1 Claude Code

Pin `@anthropic-ai/claude-agent-sdk` exactly and use its bundled matching Claude
Code. Treat patch releases as protocol changes requiring fixtures.

#### Modes

**Terminal mode**

- Spawn normal interactive Claude Code in the slot PTY.
- Preserve bytes and process state.
- Hooks, status-line JSON, process signals, and documented side channels may
  produce observational records.
- They do not make PTY approvals or tool calls authoritative.
- Automated controls are keystrokes and therefore labeled user-driven,
  best-effort terminal actions.

**Structured mode**

- Run one streaming-input Agent SDK `Query` in a main or utility process over
  its supported pipes.
- Enable partial messages and hook events only when the UI consumes them.
- Enable forwarded subagent text only when nested transcripts are a product
  requirement.
- Persist `system/init` session ID, capabilities, the exact launch manifest,
  SDK/CLI versions, and committed messages.
- Keep SDK persistence enabled initially. Do not add alpha `SessionStore` until
  cross-host mirroring is a requirement.
- The slot PTY is a companion shell, visibly separate from the query.

#### Authority and mapping

- Complete assistant/user/result SDK messages are committed evidence.
- Raw stream events are disposable deltas reconciled to complete messages.
- `canUseTool` creates host-owned pending interactions keyed by `requestId`, with
  `toolUseID` and optional `agentID` retained.
- A `PreToolUse` hook is required for policy that must inspect every call,
  because prior allow rules and permission modes can bypass `canUseTool`.
- Never map result to unconditional session completion. Error results can occur
  while a streaming session remains alive, and trailing system events may
  follow a result.
- `total_cost_usd` is a client estimate. Preserve aggregate usage and model
  usage; label cost **Estimated**.
- Subagent text forwarding is complete-message only. Do not animate token-level
  child output or claim full ancestry on older transcripts.

#### Resume and reconnect

Start a new query with the persisted session ID and the same project/config
namespace. Reapply launch-specific options because MCP config, settings,
plugin directories, fallback model, added directories, some permission modes,
and background tasks do not fully restore.

Resume restores conversation evidence, not the old process, PTY, Bash jobs,
monitor tasks, or external side effects. Any locally pending callback becomes
`stale` unless the documented reinitialization/pending behavior redelivers it.

#### Cancellation

1. Call `Query.interrupt()` when negotiated and streaming mode is active.
2. Await receipt/result/idle evidence for a bounded grace period.
3. Use `stopTask(taskId)` for a specifically reported background task.
4. Use `Query.close()` only as hard query-process teardown.
5. Kill the PTY separately only when the user explicitly stops the companion or
   terminal-owned process.

No raw stream-json stdin interrupt frame is assumed.

### 8.2 Codex

Codex app-server v2 over its supported local Unix socket is the richest first
adapter for a true dual surface.

#### Topology

```text
codex app-server daemon (0600 Unix socket)
├── Maximal structured client
└── codex TUI in slot PTY
    └── --remote unix://<socket> resume <threadId>
```

Prefer supported `codex app-server daemon start|stop|restart|version` lifecycle
commands for the default socket. A private `--listen unix://<absolute-path>`
process is acceptable when Maximal needs strict lifecycle isolation.

Both clients initialize independently. Starting, resuming, or forking a thread
subscribes that connection. The TUI and Electron can observe one thread, but
approvals are broadcast server requests and first response wins. Maximal cannot
make an unmodified visible TUI stop showing or answering approvals.

#### Approval policy

Expose one of three honest modes:

- **Shared responder:** TUI and Maximal may answer; first response wins. Maximal
  dismisses stale cards on `serverRequest/resolved` and final item state.
- **Maximal exclusive:** detach/unsubscribe/close the TUI connection while an
  interactive request is pending or for the entire controlled run.
- **Non-interactive policy:** configure the thread/turn to avoid prompts where
  appropriate.

There is no `electron-primary` protocol flag. Do not offer it.

Preserve each native approval request as a tagged raw payload. Command, file
change, and permissions approvals have different option and scope schemas.
Common normalized fields are optional projections only.

#### Events and reconciliation

- Use start/resume/fork/read responses as snapshots.
- Use completed items and completed turns as authoritative terminal records.
- Treat text/reasoning/output/patch deltas as disposable.
- App-server has no durable sequence or replay cursor. Local sequence records
  only ingestion order.
- On reconnect: initialize, resume each desired thread, replace reducer state
  from returned thread/active-turn snapshots, process replayed pending server
  requests, then accept live notifications.
- A slow socket subscriber can be disconnected when its bounded queue fills.
  Mark a possible gap, discard incomplete delta assemblies, and resnapshot.
- Preserve thread ID, session ID, fork parent, and item IDs separately. Item IDs
  are opaque strings, not assumed UUIDs.
- Treat relationship filters, some history, background terminals, permissions
  profiles, and multi-agent controls as experimental per generated schema.

`exec --json` remains a separate one-shot adapter. It is useful for isolated
jobs but does not replace app-server's bidirectional controls or approvals.

#### Cancellation

1. Send `turn/interrupt` and await `turn/completed(status='interrupted')`.
2. Do not claim it terminated background terminal processes.
3. On app-server shutdown, the first process signal drains active turns rather
   than interrupting them; a second force signal is escalation.
4. Keep `interrupt turn`, `close subscription`, `stop daemon`, and `kill PTY`
   separate in the UI.

### 8.3 GitHub Copilot CLI

The TypeScript Copilot SDK is the primary rich adapter. ACP is an optional
preview adapter with a distinct decoder and capability report. Prompt-mode JSONL
is one-shot only.

#### Modes

**Terminal mode**

- Persistent Copilot CLI in the PTY.
- OSC progress, status-line JSON, hooks, logs, and OpenTelemetry are
  observational hints only.
- No scraped approval or tool semantics.

**Structured SDK mode**

- One active SDK owner per persisted session.
- Pin compatible SDK and CLI versions.
- Verify SDK protocol version and session capabilities.
- Use high-level APIs by default: create/resume/list/delete, send, enqueue,
  immediate steering, wait for idle, abort, disconnect, model discovery,
  permission/input handlers, tools, MCP, and hooks.
- Keep experimental plan/todo/fleet/agent/permissions RPC namespaces behind
  explicit feature flags and contract fixtures.
- The PTY is a labeled companion shell.

**ACP mode**

- Own decoder, capability negotiation, cancellation, and version fixtures.
- Do not feed ACP updates through the SDK event decoder.
- `session/load`, list, resume, close, and fork are separate capabilities, not
  one `supportsResume` bit.

#### Authority and mapping

- Persist complete SDK events; render deltas/progress as ephemeral.
- Deduplicate provider events by provider ID when present. Local sequence is not
  exactly-once evidence.
- `session.idle` means no background agents or attached shell commands remain.
  `assistant.idle` is weaker and must not clear global activity.
- `session.task_complete` is best-effort and model-driven; do not substitute it
  for mechanical idle.
- Tool failure is derived from completion payload, not invented as a native
  standalone provider event.
- `permission.requested` can be reconstructed only through currently available
  pending-permission support; user input, elicitation, plan exit, and MCP OAuth
  gates may be ephemeral. Local attention records do not make them live.
- Subagent lifecycle and `agentId` attribution are visible; arbitrary child
  control and fleet operations remain experimental.

#### Ownership handoff

Do not ship SDK-to-TUI handoff initially. A later gated experiment requires:

1. mechanical `session.idle`;
2. a Maximal application lock for the provider session;
3. SDK `disconnect()`;
4. launch pinned CLI with the same session ID in the PTY;
5. verify resume before marking terminal ownership active;
6. reverse only after the TUI process exits.

Any failed step leaves the session detached, not concurrently owned.

#### Cancellation

1. SDK `abort()` for the currently processing message.
2. Await abort/error/idle evidence.
3. Resolve or cancel every pending host interaction.
4. `disconnect()` releases runtime resources but preserves provider state.
5. Process termination is explicit escalation; it cannot retract committed
   external side effects.
6. ACP uses negotiated `session/cancel` and must answer pending permission
   requests with `Cancelled` as required by the protocol.

## 9. Local persistence

Use SQLite in the Maximal client's application-data directory. Enable WAL,
foreign keys, and busy timeout. The database is the product index and reducer
state, not a claim that provider events are exactly-once.

### 9.1 Tables

```text
projects
harness_slots
harness_sessions
launch_manifests
capability_reports
processes
runs
raw_records
normalized_events
session_snapshots
interaction_requests
interaction_options
tool_calls
diffs
usage_samples
checkpoints
redactions
```

Important columns:

- all records: Maximal UUID, `created_at`, `updated_at`;
- provider resources: `provider_namespace`, opaque `provider_id`;
- events: `stream_id`, `epoch`, local `sequence`, `source_type`, `provenance`,
  `raw_record_id`;
- raw records: SHA-256, media type, compressed blob or external blob path,
  byte length, redaction status, retention class;
- interactions: provider request ID, expected provider state, local state,
  resolution, expiry/liveness status;
- checkpoints: provider cursor when one exists, snapshot hash, last local
  sequence, launch manifest hash.

Allocate `sequence` and insert raw + normalized records in one transaction. A
crash may leave provider events unobserved; it must not leave a normalized event
without its raw evidence.

### 9.2 Transcript policy

Store two independent streams:

1. **Provider raw:** JSON/JSONL envelopes exactly as received, subject to bounded
   secret redaction. Provider internal transcript files are not imported as a
   stable schema unless used by an explicit recovery/export tool.
2. **PTY raw:** output bytes with arrival order and timestamps. User input is
   excluded by default; when enabled, mark it secret-bearing and apply shorter
   retention.

Committed provider messages form the semantic transcript. PTY output forms a
viewable terminal recording. They are never silently merged.

Large raw payloads are compressed and content-addressed outside SQLite with the
metadata row in the database. Use atomic write + fsync + rename. Apply size and
age quotas per project, preserving normalized committed state after optional
raw-body expiry.

### 9.3 Secrets and redaction

- Never persist environment values, auth tokens, vault content, or full process
  environments.
- Launch manifests store environment **keys and provenance**, not values.
- Redact common credential shapes before diagnostic export, while retaining a
  hash and redaction map so event identity remains auditable.
- Encrypt especially sensitive raw bodies with an OS-protected local key when
  platform support is available.
- A manual “delete raw transcript” action must preserve a tombstone and remove
  blobs securely to the extent the filesystem permits.

## 10. Reconnect and resume

Every adapter implements this state machine:

```text
connecting → live → disconnected → reconciling → live
                         │              └──────→ degraded
                         └─────────────────────→ closed
```

### 10.1 Generic algorithm

1. Persist transport closure and whether an upstream gap is possible.
2. Cancel or mark stale every interaction whose provider liveness cannot be
   reconstructed.
3. Open the new structured transport and negotiate again.
4. Reject or degrade if required capability shapes changed.
5. Fetch the strongest provider snapshot/history available.
6. Replace reducer state for authoritative entities; never append a snapshot as
   if it were missing live deltas.
7. Reconcile pending requests and final tool/item states.
8. Discard unreconciled deltas.
9. Start a new local `epoch` if stream continuity cannot be proven.
10. Notify the renderer of recovered state and any honest data gap.

### 10.2 What resume does not mean

The UI must never say “restored exactly” merely because a conversation resumed.
Resume may not restore:

- PTY screen or emulator state after process death;
- child processes, background Bash jobs, monitors, or terminals;
- in-flight deltas;
- ephemeral questions, elicitation, OAuth, or plan-exit prompts;
- launch-only flags, permission modes, plugins, directories, MCP setup, or
  credentials;
- external side effects that happened before a crash.

Use **Conversation resumed** and then list degraded items. Reserve **Reconnected**
for a still-live provider process or daemon attachment.

## 11. Approval and interaction security

### 11.1 Trust boundary

```text
untrusted renderer
    │ validated IPC: interactionId + optionId + expected state
    ▼
trusted Electron main / utility process
    │ provider-native typed response
    ▼
active provider request
```

The renderer receives display-safe fields and opaque option IDs. It cannot send
provider JSON, tool input amendments, permission scopes, executable paths, or
arbitrary channel names.

### 11.2 Resolution rules

- Check the IPC sender and owning window.
- Require an interaction nonce bound to the renderer generation.
- Compare-and-set `pending → responding`; one winner only.
- Recheck provider request ID and pending state where possible.
- Validate granted permission as a subset of requested permission.
- Map the adapter-issued option ID to a provider-native typed result in trusted
  code.
- Persist the local decision before sending, then persist provider acceptance or
  stale resolution afterward.
- On provider rejection, do not retry an allow automatically.
- On disconnect, unknown method, malformed payload, timeout, or cancellation,
  deny/cancel or mark stale. Never fail open.

Codex shared-responder mode is explicitly weaker: first response wins across
subscribers. The card says **The Codex terminal may also answer this request**.

### 11.3 Project trust

Each project has a launch profile:

- trusted root and permitted working directories;
- inherited, injected, and disabled configuration sources;
- credential source names, never values;
- permitted provider executable path and version range;
- network/MCP inheritance status;
- terminal input-recording policy;
- raw retention and redaction policy.

Resolve and canonicalize working directories. Reject path escape through
symlinks where a control scopes filesystem access. Provider tools still enforce
their own sandbox and permission models; Maximal does not imply stronger
isolation than actually configured.

## 12. Cancellation contract

The UI exposes four separate actions based on negotiated capabilities:

| Action | Meaning |
| --- | --- |
| **Interrupt turn** | Ask the provider to stop the active model/agent turn at a safe boundary. |
| **Stop task** | Stop one provider-reported background task, when supported. |
| **Close session connection** | Disconnect Maximal while preserving resumable provider history where supported. |
| **Terminate process** | Send a graceful OS signal, then optionally force kill after confirmation. |

Cancellation state is not terminal until evidence arrives. After an interrupt
request, show **Stopping…**. Then transition from provider evidence to
**Interrupted**, **Completed before stop**, **Failed**, or **Still running**.

Escalation defaults:

1. resolve/cancel local pending interactions;
2. semantic provider interrupt/abort;
3. bounded wait for terminal evidence;
4. graceful OS termination for the owned process;
5. bounded drain;
6. force kill only after an explicit second action or declared timeout policy.

Never imply cancellation rolled back filesystem edits, network calls, commits,
or other side effects.

## 13. What the UI can honestly show

### 13.1 Universal, based on host evidence

- PTY process alive/exited and exit code.
- Terminal visible/dismissed and unread attention badge.
- Bytes received and terminal transcript availability.
- Structured transport live/degraded/disconnected.
- Installed harness and adapter versions.
- Negotiated capability details and experimental warnings.

### 13.2 Structured-only

When backed by provider evidence, the UI may show:

- committed assistant/user/tool messages;
- provisional assistant deltas, visibly marked live;
- provider-reported tool lifecycle and final outcome;
- active approval/question cards;
- provider-reported patches/diffs;
- mechanical idle versus active states where defined;
- tasks and subagent activity at the provider's actual visibility level;
- usage and estimated cost with source labels;
- snapshot reconstruction and possible gaps.

### 13.3 Required labels

- **Live** for disposable deltas.
- **Committed** for complete provider messages/items.
- **Reconstructed** for state loaded from history/snapshot after reconnect.
- **Derived** for adapter interpretations such as a run boundary the provider
  does not expose.
- **Terminal only** when no semantic lane is active.
- **Estimated cost** for Claude Code local list-rate cost and other non-billing
  values.
- **Experimental** on capability-gated provider surfaces.
- **Possible gap** after overload or non-replayable disconnect.

### 13.4 Things the UI must not claim

- “Approved” because Enter appeared to be pressed in a PTY.
- “Tool completed” because terminal output resembles a result.
- “All output restored” after resume.
- “No work remains” from assistant-idle or a quiet terminal.
- “Exact cost” from client-side estimates.
- “Subagent live transcript” when only parent tool activity is forwarded.
- “Electron owns approvals” while an unmodified Codex TUI is subscribed.
- “Same session” for a Claude Agent SDK run and interactive Claude TUI.
- “Cancelled safely” before terminal evidence or with external side effects
  unknown.

## 14. Awareness-first product phases

### Phase 0 — generic PTY lifecycle

**Goal:** make harness slots durable independently of React component mounts.

- Extend maximal-electron PTY host with executable/args, byte transport,
  process-group/job-object containment, signal escalation, attach/detach view,
  and bounded journaling.
- Keep Ghostty mounted while switching tabs; dismissal hides the host.
- Separate Close view, Disconnect semantic lane, Interrupt, and Terminate.
- Add packaged native-module verification.

Exit test: three harness PTYs survive tab switches and window dismiss/restore;
closing one view does not kill its process; explicit terminate kills only its
process group.

### Phase 1 — local model and honest terminal awareness

**Goal:** ship value without structured control.

- Projects, slots, processes, terminal transcript, launch manifests, version
  probing, notifications, and local SQLite.
- No terminal parser beyond the emulator.
- Status-line/OSC/hooks may produce clearly observational hints.
- Capability inspector explains why semantic controls are absent.

Exit test: restart the app and recover projects, exited/live process records,
terminal metadata, and transcripts without inventing session state.

### Phase 2 — Codex app-server PoC

**Why first:** it is the only verified provider that supports a visible PTY TUI
and rich structured Electron client on the same live provider thread.

Scope:

- managed local daemon on Unix socket;
- generated stable schemas pinned to the shipped Codex binary;
- initialize, thread start/resume/read, turn start/interrupt, item/turn events;
- PTY TUI with explicit `--remote` resume;
- snapshot-first reducer and overload/reconnect recovery;
- shared-responder approval warning, with exclusive mode implemented by TUI
  detach;
- no experimental multi-agent control.

Exit test: kill and reconnect the Electron socket during a live turn, recover
from a thread snapshot, discard incomplete deltas, resolve or stale an approval
correctly, and keep the TUI attached.

### Phase 3 — Claude Agent SDK PoC

Scope:

- exact SDK pin and bundled CLI;
- streaming-input structured mode as a separate run from terminal mode;
- init capabilities, committed messages, optional deltas, results, task events,
  approval callbacks, interrupt, close, session resume, and launch-manifest
  restoration;
- `PreToolUse` policy hook for universal inspection;
- estimated usage only;
- no SessionStore, raw stream-json controller, or same-run TUI promise.

Exit test: interrupt and resume a session, restart Electron, reapply launch
options, handle duplicate/redelivered approval request IDs idempotently, and
prove terminal text cannot resolve a callback.

### Phase 4 — Copilot SDK PoC

Scope:

- one SDK owner per session;
- protocol/capability checks;
- committed/ephemeral event handling, permission callbacks, mechanical session
  idle, abort, disconnect, and resume;
- experimental RPCs disabled;
- no TUI handoff.

Exit test: crash between ephemeral gate display and response, resume without
presenting the dead gate as actionable, and prove concurrent owner acquisition
is rejected by the Maximal lock.

### Phase 5 — optional ACP and one-shot adapters

- Copilot ACP preview behind independent conformance fixtures.
- Codex exec JSON and Claude print/stream JSON for isolated jobs only.
- No persistence or control capability inherited from the primary adapter.

### Phase 6 — orchestration

Only after all primary adapters pass fault tests:

- user-authored queues and run templates;
- cross-provider attention inbox;
- explicit policies for auto-deny or observation-only operation;
- optional bounded automatic starts and retries;
- never automatic approval of side effects by default.

## 15. Testing strategy

### 15.1 Contract fixtures per exact version

For every supported harness/adapter pair, capture sanitized raw sessions for:

- init and capability negotiation;
- one committed assistant response and deltas;
- successful, failed, denied, and interrupted tool calls;
- every supported interaction request family;
- usage and terminal results;
- unknown event/enum/field injection;
- subagent/task activity;
- reconnect snapshot/history;
- graceful interrupt and hard close.

Golden tests decode raw fixtures, preserve unknown fields, normalize expected
minimal events, and verify raw round-trip identity. A new provider patch cannot
ship until fixtures pass or the capability range is narrowed.

### 15.2 Reducer model tests

Property-test these invariants:

- committed messages replace matching delta scratch buffers;
- duplicate raw provider IDs do not duplicate committed entities;
- local sequence is monotonic within one epoch;
- a new epoch cannot imply continuity with the previous epoch;
- final provider item state overrides adapter-derived state;
- stale interactions cannot return to pending without a new provider request;
- one interaction resolution wins;
- session idle, assistant idle, process exit, and turn completion remain
  distinct;
- snapshot application is idempotent;
- unknown events cannot create approvals or controls.

### 15.3 Fault injection

Run live, version-pinned tests that:

- sever sockets between delta and committed message;
- fill the Codex subscriber queue and force overload disconnect;
- kill Electron renderer while main and PTY survive;
- kill the semantic child while PTY survives, and vice versa;
- restart Electron during a pending approval;
- race approval response from Codex TUI and Electron;
- send duplicate callback/request IDs;
- change provider version to one with an unknown enum;
- interrupt before tool execution, during execution, and after side effect;
- terminate once for graceful drain and again for force;
- resume with missing launch flags or changed working-tree identity;
- exhaust SQLite disk/quota and verify fail-closed interaction behavior.

### 15.4 Security tests

- IPC channel allowlist and runtime schema rejection.
- Wrong-window and stale-renderer interaction response rejection.
- Option-ID tampering and scope-escalation rejection.
- Symlink/path escape in project roots and transcript exports.
- Environment and credential redaction.
- Malicious provider strings rendered as data, never instructions.
- Unknown approval methods default to no affirmative action.
- PTY escape sequences cannot invoke semantic IPC.
- Raw transcript export requires explicit user action and redaction preview.

Use mutation testing on approval state transitions, capability gates, path
checks, and fail-closed branches.

### 15.5 End-to-end and packaging

- Real Ghostty canvas rendering, keyboard, resize, alternate screen, tab
  dismissal, and reattachment.
- Three concurrent harness slots with high-volume output and IPC backpressure.
- Packaged application includes PTY native dependencies and provider utility
  assets.
- Renderer sandbox remains enabled and cannot access Node or provider sockets.
- macOS and Windows process containment; Linux when supported.

## 16. Operational diagnostics

A user-visible capability inspector should export a redacted diagnostic bundle:

- Maximal schema and database migration version;
- harness executable path and version;
- adapter/SDK/protocol version;
- launch mode and correlation mode;
- negotiated capability report;
- transport state transitions and gap markers;
- latest snapshot hashes and raw record IDs;
- no credential values, prompt bodies, tool inputs, or terminal bytes unless the
  user explicitly includes transcript data.

Metrics remain local by default:

- events and raw bytes ingested;
- delta-to-commit latency;
- reconnect count and possible-gap count;
- stale interaction count;
- dropped/redacted raw bytes;
- adapter decode failures by source type;
- cancellation latency and escalation stage.

## 17. First implementation recommendation

Implement **Phase 0, Phase 1, then the Codex app-server PoC**.

This ordering proves the two hardest universal seams without prematurely
inventing a provider-neutral orchestrator:

1. A harness PTY can live independently of its React view, be brought forward
   and dismissed, preserve bytes, and stop gracefully.
2. A rich structured adapter can coexist with that visible TUI on one real
   provider thread, reconnect through snapshots, and expose honest approval
   ownership.

The first vertical slice should support exactly:

- one local project;
- one Codex harness slot;
- one managed Unix-socket daemon;
- one PTY TUI attached with `--remote`;
- thread start/resume/read;
- turn start/interrupt;
- committed messages/items, disposable text deltas, tool final states, and
  tagged approval requests;
- SQLite raw + normalized persistence;
- live/committed/reconstructed/gap labels;
- shared-responder approval mode plus TUI-detached exclusive mode;
- socket-loss reconciliation and process cancellation escalation.

Do not include in the first slice:

- Claude or Copilot adapters;
- ACP;
- subagent control;
- provider-neutral automatic approval policy;
- cross-provider orchestration;
- SessionStore or provider-internal transcript parsing;
- billing dashboards;
- terminal scraping;
- maximal-core dependency.

After this slice passes reconnect, approval-race, slow-consumer, renderer-crash,
and packaging tests, add Claude Agent SDK as the second adapter. That second
adapter is the proof that the normalized model handles a provider whose
structured and PTY modes are deliberately separate. Copilot SDK comes third and
proves exclusive session ownership and ephemeral-gate recovery.

This sequence produces useful awareness at every phase and forces the product
to remain truthful before it gains automation power.
