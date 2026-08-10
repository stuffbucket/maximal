import js from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// client/ is a separate npm-managed TypeScript project (see docs/code-style.md
// and client/package.json) with no ESLint config of its own until now. This
// mirrors the *shape* of the root flat config (../eslint.config.js) — a plain
// array of flat-config objects — but NOT its plugin set: the root config's
// shared @echristian/eslint-config bundles a large stylistic layer (unicorn,
// perfectionist import/prop sorting, prettier-as-an-eslint-rule, max-lines,
// complexity caps, ...) tuned for the proxy core's existing style. Applying
// that wholesale to a dozen brand-new client files would produce churn
// unrelated to defects. This config instead targets the specific defect
// classes worth catching here: dead code and missing/incorrect React hook
// dependencies (several new components manage subscription lifecycles, where
// a missing dep is a real bug, not a style nit).
//
// IMPORTANT — why Babel, not typescript-eslint: client/package.json pins
// `typescript: ^7.0.2`. typescript-eslint 8.x (the only line published as of
// this writing) hard-refuses to load at all against TS >=7 — every one of
// its packages (`typescript-eslint`, `@typescript-eslint/parser`,
// `@typescript-eslint/eslint-plugin`) throws `typescript-eslint does not
// support TS 7.0` at import time, unconditionally, even for plain
// (non-type-aware) parsing. See
// https://github.com/typescript-eslint/typescript-eslint/issues/10940 and
// https://github.com/typescript-eslint/typescript-eslint/issues/12518.
// There is no supported path today short of running a second, aliased
// TypeScript <6.1 install just for the linter (the "side by side" pattern
// TypeScript's own 7.0 announcement describes) — that is a real dependency-
// story change (a shadow compiler whose type layer can disagree with the
// real `tsc`) and deliberately NOT done here without a human sign-off; see
// the lint task report for the decision point.
//
// So: this config uses `@babel/eslint-parser` (Babel 7.x — a long-stable,
// well-understood combination for "parse TS/TSX, no type information") to
// get real syntax parsing for `.ts`/`.tsx`, which unlocks react-hooks and
// core unused-vars checking. What this does NOT get us: type-aware rules
// like `@typescript-eslint/no-floating-promises` or `no-unsafe-*` (those
// need a TypeScript type checker, which is exactly what's blocked above).
// That gap is real and should be revisited once typescript-eslint ships TS 7
// support (tracked in #10940) or a human decides the shadow-compiler
// tradeoff is worth it.
//
// Deliberately NOT using `eslint-plugin-unused-imports` (which would give
// autofix for dead imports): it unconditionally `require()`s
// `@typescript-eslint/eslint-plugin` internally to borrow its no-unused-vars
// implementation. `client/` is a nested directory inside this repo, not an
// npm workspace, so that require can resolve PAST client/node_modules to the
// *root* repo's node_modules (which has its own @typescript-eslint/* on a
// TypeScript 5.x the version guard above doesn't reject) — and then crashes
// for a different reason: it feeds Babel's AST into a visitor built for
// typescript-eslint's AST shape. Confirmed by hand while building this
// config. Core `no-unused-vars` below has no such cross-boundary dependency.
export default [
  { ignores: ["node_modules/**", "out/**", "build/**", ".vite/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts"],
    languageOptions: {
      parser: babelParser,
      sourceType: "module",
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript", "@babel/preset-react"],
        },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // rules-of-hooks + exhaustive-deps. The latter is the whole reason
      // react-hooks is here: several new dashboard/first-run components
      // subscribe to core-client events in a `useEffect`, and a dep left off
      // that list is a real "stale closure" bug class, not a style nit.
      ...reactHooks.configs["recommended-latest"].rules,
      // TypeScript's own compiler (`tsc --noEmit`, wired into `npm run
      // typecheck`) is the authority on undefined/undeclared identifiers.
      // Core `no-undef` predates TS and does not understand type-only
      // positions (object type literals, ambient globals like
      // `NodeJS.Signals`, etc.); with a Babel-based parser (no TS type
      // layer — see file header) it fires false positives on every property
      // name inside a type literal. Standard practice for TS projects is to
      // disable it in favor of the type checker.
      "no-undef": "off",
      // Also off, for `.tsx` — confirmed by hand (minimal repro) that
      // @babel/eslint-parser's bundled scope analyzer does not register a
      // JSX element's tag name (`<Something />`) as a reference to the
      // identifier it names, at all. That is not a TS-specific edge case:
      // `import { Something } from './x'; ... return <Something />` — the
      // single most ordinary React import pattern there is — is reported as
      // an unused import. Turning this rule on would flag most component
      // files' own component imports. Left for a human alongside the
      // typescript-eslint gap above; both need either TS 7 support upstream
      // or the shadow-6.x-compiler workaround to fix properly.
      "no-unused-vars": "off",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@stuffbucket/maximal-core/client",
              message: "The private control connection belongs to Electron main; use a surface capability adapter.",
            },
            {
              name: "@stuffbucket/maximal-core/contract",
              message: "Wire protocol details belong to Electron main, not the product renderer.",
            },
            {
              name: "@stuffbucket/maximal-core/control-contract",
              message: "Control protocol details belong to Electron main, not the product renderer.",
            },
          ],
          patterns: [
            {
              group: ["**/shared/bridge-channels", "**/shared/bridge-channels.*"],
              message: "IPC channel names are main/preload-only; use window.maximal through a capability adapter.",
            },
          ],
        },
      ],
    },
  },
];
