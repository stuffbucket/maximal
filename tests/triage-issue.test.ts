import { describe, expect, test } from "bun:test"

import { isTriaged, triageAction } from "../scripts/triage-issue"

describe("isTriaged", () => {
  test.each([
    [["playbook:feature"], true],
    [["playbook:refactoring", "design-system"], true],
    [["playbook:bug-fix", "repro:verified"], true],
    [["playbook:perf-issue", "repro:pending"], true],
    [["playbook:bug-fix"], false],
    [["playbook:perf-issue", "repro:verified", "repro:pending"], false],
    [["playbook:feature", "playbook:bug-fix", "repro:verified"], false],
    [["bug"], false],
    [[], false],
  ])("%p is triaged: %p", (labels, expected) => {
    expect(isTriaged(labels)).toBe(expected)
  })
})

describe("triageAction", () => {
  test("flags an issue with no playbook", () => {
    expect(triageAction(["bug"])).toBe("add")
  })

  test("clears the flag once the labels are complete", () => {
    expect(
      triageAction(["needs-triage", "playbook:bug-fix", "repro:pending"]),
    ).toBe("remove")
  })

  test("re-flags a bug fix whose repro label was removed", () => {
    expect(triageAction(["playbook:bug-fix"])).toBe("add")
  })

  test("leaves an already-flagged or already-complete issue alone", () => {
    expect(triageAction(["needs-triage"])).toBe("none")
    expect(triageAction(["playbook:feature"])).toBe("none")
  })

  test("leaves issues repoman routes on its own", () => {
    expect(triageAction(["needs-bot"])).toBe("none")
    expect(triageAction(["repoman:internal", "needs-triage"])).toBe("none")
  })
})
