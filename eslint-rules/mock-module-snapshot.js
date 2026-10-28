// Bun's `mock.module(id, factory)` patches the module's live namespace object
// in place. A namespace captured with `await import(id)` or `import * as ns`
// is that same object, so after the mock is installed it holds the STUB, and a
// restore like `mock.module(id, () => real)` or `() => ({ ...real })` puts the
// stub back instead of the real module. The stub then leaks into every later
// test file. Snapshot the module before mocking instead:
//
//   const real = { ...(await import(id)) }
//
// This rule flags any reference, inside an inline `mock.module` factory, to a
// variable bound to a live module namespace. See docs/architecture.md →
// Testing gotchas.

/**
 * An expression as typescript-eslint parses it: ESTree plus the TypeScript-only
 * wrappers that matter here.
 *
 * @typedef {import("estree").Expression | TsWrapper} AnyExpression
 * @typedef {{
 *   type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression",
 *   expression: AnyExpression,
 * }} TsWrapper
 */

const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
])

/**
 * Strip `x as T`, `x satisfies T`, and `x!`, so
 * `(await import(id)) as typeof import(id)` is still recognised.
 *
 * @param {AnyExpression | null | undefined} node
 * @returns {import("estree").Expression | null | undefined}
 */
function unwrapTsExpression(node) {
  let current = node
  while (current && TS_WRAPPERS.has(current.type)) {
    current = /** @type {TsWrapper} */ (current).expression
  }
  return /** @type {import("estree").Expression | null | undefined} */ (current)
}

/**
 * True when the variable is bound to a module's live namespace object:
 * `import * as ns from "m"` or `const ns = await import("m")`.
 *
 * @param {import("eslint").Scope.Variable} variable
 */
function isLiveNamespaceBinding(variable) {
  return variable.defs.some((def) => {
    if (def.type === "ImportBinding") {
      return def.node.type === "ImportNamespaceSpecifier"
    }
    if (def.type !== "Variable" || def.node.id.type !== "Identifier") {
      return false
    }
    const init = unwrapTsExpression(def.node.init)
    return (
      init?.type === "AwaitExpression"
      && unwrapTsExpression(init.argument)?.type === "ImportExpression"
    )
  })
}

/** @param {import("estree").CallExpression} node */
function isMockModuleCall(node) {
  const { callee } = node
  return (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.object.type === "Identifier"
    && callee.object.name === "mock"
    && callee.property.type === "Identifier"
    && callee.property.name === "module"
  )
}

/** @type {import("eslint").Rule.RuleModule} */
const mockModuleSnapshot = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require mock.module factories to use a snapshot of the real module, not its live namespace",
    },
    schema: [],
    messages: {
      liveNamespace:
        "`{{name}}` is the module's live namespace, which mock.module patches in place, so it holds the stub once the mock is installed and restoring from it puts the stub back. Snapshot it before mocking: `const {{name}} = { ...(await import(...)) }`. See docs/architecture.md → Testing gotchas.",
    },
  },
  create(context) {
    const { sourceCode } = context
    return {
      CallExpression(node) {
        if (!isMockModuleCall(node)) return
        const factory = node.arguments.at(1)
        if (
          factory?.type !== "ArrowFunctionExpression"
          && factory?.type !== "FunctionExpression"
        ) {
          return
        }
        // `through` holds every reference the factory (including nested
        // functions) makes to a binding declared outside it.
        for (const reference of sourceCode.getScope(factory).through) {
          const variable = reference.resolved
          if (variable && isLiveNamespaceBinding(variable)) {
            context.report({
              node: reference.identifier,
              messageId: "liveNamespace",
              data: { name: variable.name },
            })
          }
        }
      },
    }
  },
}

export default mockModuleSnapshot
