import config from "@echristian/eslint-config"

// The single-mechanism invariant (ADR-0001): a credential token becomes an
// Authorization / x-api-key header in EXACTLY one file, `src/lib/http/send-request.ts`.
// This rule bans hand-building an auth string (`Bearer …`, `token …`) anywhere
// else, so "one mechanism" can't silently regress — a new endpoint that tries
// to attach its own token fails CI and is pushed toward sendRequest().
//
// We ban ATTACHMENT (constructing the auth value), not token READS: presence
// guards (`if (!state.copilotToken)`), fallback resolution, and lifecycle
// writes are all legitimate reads and far too numerous to allowlist. The leak
// vector the goal targets is a request leaving with a hand-attached token —
// that's the template-literal below.
const tokenAttachmentGuard = {
  name: "credential-attachment-single-mechanism",
  files: ["src/**/*.ts"],
  ignores: [
    // The mechanism itself — the ONE place tokens become auth headers.
    "src/lib/http/send-request.ts",
    // Web-tools sandbox executor forwards a SEPARATE sandbox apiKey (not a
    // GitHub/Copilot token) to the web-tools service. Different credential
    // domain; not yet folded into sendRequest. Tracked as a follow-up.
    "src/routes/messages/web-tools/executor.ts",
    // Loopback smoke test sends a DUMMY x-api-key ("anything") to its own
    // server — not a real credential.
    "src/setup.ts",
    "**/*.test.ts",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "TemplateLiteral > TemplateElement[value.raw=/(?:Bearer |token )$/]",
        message:
          "Do not hand-build an Authorization value. Route the request through sendRequest() with a Credential; the token is attached inside src/lib/http/send-request.ts. See ADR-0001.",
      },
      {
        selector:
          "Property[key.value='x-api-key'], Property[key.name='x-api-key']",
        message:
          "Do not hand-attach an x-api-key header. Route the request through sendRequest() with a Credential ('anthropic'/'provider'); the key is attached inside src/lib/http/send-request.ts. See ADR-0001.",
      },
    ],
  },
}

// Ban the leak-prone `mock.module()` idiom in tests. Bun does NOT reset module
// mocks between files, and — verified empirically on Bun 1.3.11 — neither
// `mock.restore()` nor an UNAWAITED `void mock.module(id, () => actual)` in an
// afterAll actually lands the restore for a later file's static imports. So a
// fire-and-forget `void mock.module(...)` (install OR restore) leaks its stub
// FORWARD into unrelated test files, which then read a stale mocked export.
// This caused #229's CI-only flake: a leaked `getConfig` closure made a real
// config round-trip read `enabled: false`.
//
// The rule flags the two fire-and-forget statement forms — `void mock.module(…)`
// and a bare `mock.module(…)` expression statement. The safe form is an
// AWAITED call (`await mock.module(…)`), which lands deterministically: install
// with `await mock.module(id, factory)` and ALWAYS restore in an
// `afterAll(async () => { await mock.module(id, () => actual) })`. Better still,
// use the real module (the test preload redirects COPILOT_API_HOME to a temp
// dir, so config/token round-trips are already isolated) or inject deps.
//
// It ALSO bans `mock.module("srvx", …)` in any form (awaited or not). srvx's
// `serve` binds real ports; even an awaited restore leaves the live binding
// half-rewired, so mocking it here breaks the one real-port test that needs
// the genuine serve (tests/ws/srvx-upgrade-handshake.test.ts). Inject the
// binder through `__setServeForTests` from ~/start instead.
const mockModuleLeakGuard = {
  name: "no-unrestored-mock-module",
  files: ["tests/**/*.ts"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          'ExpressionStatement > UnaryExpression[operator="void"] > CallExpression[callee.object.name="mock"][callee.property.name="module"]',
        message:
          "Unrestored `void mock.module(...)` leaks across test files (Bun does not reset module mocks between files, and an unawaited restore never lands). Prefer the real module (COPILOT_API_HOME is redirected to a temp dir by the test preload) or injectable deps; if a stub is truly required, `await mock.module(id, factory)` and restore it in `afterAll(async () => { await mock.module(id, () => actual) })`.",
      },
      {
        selector:
          'ExpressionStatement > CallExpression[callee.object.name="mock"][callee.property.name="module"]',
        message:
          "Unawaited `mock.module(...)` leaks across test files (Bun does not reset module mocks between files). `await` it and restore it in an awaited afterAll, or prefer the real module / injectable deps.",
      },
      {
        selector:
          'CallExpression[callee.object.name="mock"][callee.property.name="module"][arguments.0.value="srvx"]',
        message:
          'Do not `mock.module("srvx", …)`. srvx\'s `serve` binds real ports; the module mock leaks the stub into the real-port WS handshake test (tests/ws/srvx-upgrade-handshake.test.ts) and its restore leaves the live binding half-rewired. Inject the binder via `__setServeForTests` from ~/start instead.',
      },
    ],
  },
}

export default [
  ...config({
    ignores: [
      ".opencode/**",
      "contrib/**",
      "docs/**",
      "scripts/**",
      "shell/**",
      "site/**",
      ".dependency-cruiser.cjs",
      "landing/**",
    ],
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  }),
  tokenAttachmentGuard,
  mockModuleLeakGuard,
]
