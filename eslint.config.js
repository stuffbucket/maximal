import config from "@echristian/eslint-config"

// The single-mechanism invariant (ADR-0001): a credential token becomes an
// Authorization / x-api-key header in EXACTLY one file, `src/lib/send-request.ts`.
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
    "src/lib/send-request.ts",
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
          "Do not hand-build an Authorization value. Route the request through sendRequest() with a Credential; the token is attached inside src/lib/send-request.ts. See ADR-0001.",
      },
      {
        selector:
          "Property[key.value='x-api-key'], Property[key.name='x-api-key']",
        message:
          "Do not hand-attach an x-api-key header. Route the request through sendRequest() with a Credential ('anthropic'/'provider'); the key is attached inside src/lib/send-request.ts. See ADR-0001.",
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
]
