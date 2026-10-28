/**
 * Windows containment for `serve`: before it starts anything, the broker puts
 * itself in a Job Object that kills every process in it when its last handle
 * closes, and holds that handle until it exits. The MCP servers it starts,
 * and whatever they start, are created inside the job too (the job doesn't
 * allow breakaway), so when the broker exits or is terminated, Windows ends
 * all of them. This is the Windows side of the containment contract; on
 * POSIX the supervisor gets the same from a process group.
 *
 * If any step fails the broker refuses to run: it exits with
 * CONTAINMENT_EXIT_CODE, and the supervisor reports that instead of retrying.
 */
import { dlopen, FFIType } from "bun:ffi"

export const CONTAINMENT_UNAVAILABLE = "MCP_BROKER_CONTAINMENT_UNAVAILABLE"

/** How a broker that couldn't contain itself exits. Mirrored by the
 *  supervisor (`BROKER_CONTAINMENT_EXIT_CODE`). */
export const CONTAINMENT_EXIT_CODE = 78

/** JOBOBJECTINFOCLASS JobObjectExtendedLimitInformation. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows. */
const EXTENDED_LIMIT_INFORMATION_BYTES = 144
/** BasicLimitInformation.LimitFlags, after two LARGE_INTEGERs. */
const LIMIT_FLAGS_OFFSET = 16

export type ContainmentStep = "load" | "create" | "limit" | "assign" | "verify"

export class ContainmentError extends Error {
  readonly code = CONTAINMENT_UNAVAILABLE
  readonly step: ContainmentStep
  /** GetLastError() after the failed call, when there was one. */
  readonly windowsError: number | undefined

  constructor(step: ContainmentStep, windowsError?: number) {
    super(CONTAINMENT_UNAVAILABLE)
    this.name = "ContainmentError"
    this.step = step
    this.windowsError = windowsError
  }
}

/** The kernel32 calls containment needs. A handle is a pointer-sized
 *  integer; 0n is a failed CreateJobObjectW. */
export interface JobObjectApi {
  createJobObject(): bigint
  setInformation(job: bigint, infoClass: number, info: Uint8Array): boolean
  assignProcess(job: bigint, process: bigint): boolean
  isProcessInJob(process: bigint, job: bigint): boolean
  currentProcess(): bigint
  lastError(): number
}

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only KILL_ON_JOB_CLOSE set:
 *  no other limits, and no breakaway for anything started inside. */
export function killOnCloseLimits(): Uint8Array {
  const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_BYTES)
  new DataView(info.buffer).setUint32(
    LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  )
  return info
}

/** kernel32 through bun:ffi. Only loaded on Windows. */
export function loadKernel32(): JobObjectApi {
  const { symbols } = dlopen("kernel32.dll", {
    CreateJobObjectW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u64,
    },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    AssignProcessToJobObject: {
      args: [FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    IsProcessInJob: {
      args: [FFIType.u64, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  return {
    // No security attributes: the handle isn't inheritable, so no child
    // can keep the job open after the broker is gone. No name, either.
    createJobObject: () => BigInt(symbols.CreateJobObjectW(null, null)),
    setInformation: (job, infoClass, info) =>
      symbols.SetInformationJobObject(job, infoClass, info, info.byteLength)
      !== 0,
    assignProcess: (job, process) =>
      symbols.AssignProcessToJobObject(job, process) !== 0,
    isProcessInJob: (process, job) => {
      const result = new Int32Array(1)
      return symbols.IsProcessInJob(process, job, result) !== 0 && result[0] !== 0
    },
    currentProcess: () => BigInt(symbols.GetCurrentProcess()),
    lastError: () => symbols.GetLastError(),
  }
}

/**
 * Put this process in a new kill-on-close job and return the job's handle,
 * or throw ContainmentError. Does nothing off Windows. Call it once, before
 * anything starts a process. The handle is never closed: process exit
 * closes it, and that is what ends the job.
 */
export function containInKillOnCloseJob(
  platform: NodeJS.Platform = process.platform,
  load: () => JobObjectApi = loadKernel32,
): bigint | undefined {
  if (platform !== "win32") return undefined

  let api: JobObjectApi
  try {
    api = load()
  } catch {
    throw new ContainmentError("load")
  }
  const job = api.createJobObject()
  if (job === 0n) throw new ContainmentError("create", api.lastError())
  // From here the handle is never closed: a job with no limits and no
  // processes is harmless, and a failure below ends the process anyway.
  if (
    !api.setInformation(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, killOnCloseLimits())
  ) {
    throw new ContainmentError("limit", api.lastError())
  }
  const self = api.currentProcess()
  if (!api.assignProcess(job, self)) {
    throw new ContainmentError("assign", api.lastError())
  }
  if (!api.isProcessInJob(self, job)) {
    throw new ContainmentError("verify", api.lastError())
  }
  return job
}

/** The stderr line for a containment failure: the code, and which step
 *  Windows refused. */
export function describeContainmentError(error: ContainmentError): string {
  const detail =
    error.windowsError === undefined ? "" : ` error=${error.windowsError}`
  return `${error.code} step=${error.step}${detail}`
}
