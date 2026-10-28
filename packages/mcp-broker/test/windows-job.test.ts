import { describe, expect, it } from "bun:test"

import {
  CONTAINMENT_UNAVAILABLE,
  ContainmentError,
  containInKillOnCloseJob,
  describeContainmentError,
  type JobObjectApi,
  killOnCloseLimits,
} from "../src/windows-job.ts"

const JOB = 0x1234n
const SELF = 0xffff_ffff_ffff_ffffn

interface Call {
  name: string
  args: Array<unknown>
}

/** A kernel32 stand-in that records calls; `fail` names the call that
 *  reports failure. */
const fakeKernel32 = (fail?: keyof JobObjectApi) => {
  const calls: Array<Call> = []
  const record = <T>(name: keyof JobObjectApi, ok: T, failed: T) =>
    (...args: Array<unknown>): T => {
      calls.push({ name, args })
      return fail === name ? failed : ok
    }
  const api: JobObjectApi = {
    createJobObject: record("createJobObject", JOB, 0n),
    setInformation: record("setInformation", true, false),
    assignProcess: record("assignProcess", true, false),
    isProcessInJob: record("isProcessInJob", true, false),
    currentProcess: record("currentProcess", SELF, SELF),
    lastError: () => 5,
  }
  return { api, calls }
}

describe("killOnCloseLimits", () => {
  it("is a 64-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only KILL_ON_JOB_CLOSE", () => {
    const info = killOnCloseLimits()
    expect(info.byteLength).toBe(144)
    const view = new DataView(info.buffer)
    expect(view.getUint32(16, true)).toBe(0x2000)
    // Nothing else is limited, and breakaway isn't allowed.
    const rest = [...info].filter((_, index) => index < 16 || index >= 20)
    expect(rest.every((byte) => byte === 0)).toBe(true)
  })
})

describe("containInKillOnCloseJob", () => {
  it("does nothing off Windows", () => {
    let loaded = false
    const load = () => {
      loaded = true
      return fakeKernel32().api
    }
    expect(containInKillOnCloseJob("darwin", load)).toBeUndefined()
    expect(containInKillOnCloseJob("linux", load)).toBeUndefined()
    expect(loaded).toBe(false)
  })

  it("creates the job, sets kill-on-close, assigns this process, and checks it", () => {
    const { api, calls } = fakeKernel32()
    expect(containInKillOnCloseJob("win32", () => api)).toBe(JOB)
    expect(calls.map((call) => call.name)).toEqual([
      "createJobObject",
      "setInformation",
      "currentProcess",
      "assignProcess",
      "isProcessInJob",
    ])
    const [job, infoClass, info] = calls[1].args as [bigint, number, Uint8Array]
    expect(job).toBe(JOB)
    expect(infoClass).toBe(9)
    expect(new DataView(info.buffer).getUint32(16, true)).toBe(0x2000)
    expect(calls[3].args).toEqual([JOB, SELF])
    expect(calls[4].args).toEqual([SELF, JOB])
  })

  const failures = [
    ["createJobObject", "create"],
    ["setInformation", "limit"],
    ["assignProcess", "assign"],
    ["isProcessInJob", "verify"],
  ] as const
  for (const [call, step] of failures) {
    it(`fails closed when ${call} fails`, () => {
      const { api } = fakeKernel32(call)
      let thrown: unknown
      try {
        containInKillOnCloseJob("win32", () => api)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ContainmentError)
      expect(thrown).toMatchObject({
        code: CONTAINMENT_UNAVAILABLE,
        step,
        windowsError: 5,
      })
    })
  }

  it("stops before assigning when the limit can't be set", () => {
    const { api, calls } = fakeKernel32("setInformation")
    expect(() => containInKillOnCloseJob("win32", () => api)).toThrow(
      ContainmentError,
    )
    expect(calls.some((call) => call.name === "assignProcess")).toBe(false)
  })

  it("fails closed when kernel32 can't be loaded", () => {
    expect(() =>
      containInKillOnCloseJob("win32", () => {
        throw new Error("no kernel32 here")
      }),
    ).toThrow(
      expect.objectContaining({ code: CONTAINMENT_UNAVAILABLE, step: "load" }),
    )
  })
})

describe("describeContainmentError", () => {
  it("names the code, the step, and Windows' error when there is one", () => {
    expect(describeContainmentError(new ContainmentError("assign", 5))).toBe(
      "MCP_BROKER_CONTAINMENT_UNAVAILABLE step=assign error=5",
    )
    expect(describeContainmentError(new ContainmentError("load"))).toBe(
      "MCP_BROKER_CONTAINMENT_UNAVAILABLE step=load",
    )
  })
})
