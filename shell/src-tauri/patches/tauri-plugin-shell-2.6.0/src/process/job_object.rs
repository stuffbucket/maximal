// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Job object backing `process_group` on Windows, adapted from
//! [process-wrap](https://github.com/watchexec/process-wrap) (Apache-2.0 OR MIT).

use std::{io, mem, os::windows::io::AsRawHandle, process::Child, ptr};

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};

/// Owned job object handle. Closing it terminates every process in the job.
#[derive(Debug)]
pub(crate) struct JobObject(HANDLE);

// SAFETY: the handle is only ever passed to thread-safe Win32 calls.
unsafe impl Send for JobObject {}
unsafe impl Sync for JobObject {}

impl JobObject {
    /// Creates a job object, assigns the `CREATE_SUSPENDED` `child` to it and resumes the child.
    pub(crate) fn assign(child: &Child) -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(job);

        // Maximal patch: make the Job Object a kernel-level lifetime boundary.
        // This is configured before the suspended child is assigned and resumed,
        // so neither the child nor any descendant gets an escape window.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_threads(child.id())?;
        Ok(job)
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// `std` closes the main thread handle right after `CreateProcess`, so a suspended
/// child can only be resumed by looking its threads up again.
fn resume_threads(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let result = resume_snapshot_threads(snapshot, pid);
    unsafe { CloseHandle(snapshot) };
    result
}

fn resume_snapshot_threads(snapshot: HANDLE, pid: u32) -> io::Result<()> {
    let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
    let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while found {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            if unsafe { ResumeThread(thread) } == u32::MAX {
                let err = io::Error::last_os_error();
                unsafe { CloseHandle(thread) };
                return Err(err);
            }
            unsafe { CloseHandle(thread) };
        }
        found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED},
    };

    fn find_process(parent_pid: Option<u32>, pid: Option<u32>) -> io::Result<Option<u32>> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        let mut result = None;
        while found {
            if parent_pid.is_none_or(|value| entry.th32ParentProcessID == value)
                && pid.is_none_or(|value| entry.th32ProcessID == value)
            {
                result = Some(entry.th32ProcessID);
                break;
            }
            found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        Ok(result)
    }

    #[test]
    fn closing_job_terminates_assigned_process_tree() -> io::Result<()> {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping -n 60 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()?;
        let job = match JobObject::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        assert!(child.try_wait()?.is_none(), "test process exited too early");

        let descendant_deadline = Instant::now() + Duration::from_secs(5);
        let descendant_pid = loop {
            if let Some(pid) = find_process(Some(child.id()), None)? {
                break pid;
            }
            if child.try_wait()?.is_some() {
                panic!("test process exited before starting its descendant");
            }
            if Instant::now() >= descendant_deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("test process did not start a descendant");
            }
            thread::sleep(Duration::from_millis(25));
        };

        drop(job);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let leader_exited = child.try_wait()?.is_some();
            let descendant_exited = find_process(None, Some(descendant_pid))?.is_none();
            if leader_exited && descendant_exited {
                return Ok(());
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &descendant_pid.to_string(), "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                panic!(
                    "process tree survived after its job handle closed (leader exited: {leader_exited}, descendant exited: {descendant_exited})"
                );
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}
