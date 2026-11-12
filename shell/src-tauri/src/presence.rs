//! Presence: whether the screen is locked and how long the person has been
//! idle, reported to the sidecar so budget limits can apply only while they
//! are away (`src/lib/presence.ts`, `POST /settings/api/presence`).
//!
//! Local only, and nothing but three fields is ever sent: `locked`,
//! `idleSeconds` and `at`. No app names, window titles or input content are
//! read; the OS reports one number (time since the last input) and one flag.
//! `None` means the platform can't say, which the sidecar treats as "not
//! away".
//!
//! macOS reads `CGEventSourceSecondsSinceLastEventType` and
//! `CGSessionCopyCurrentDictionary`; Windows reads `GetLastInputInfo` and the
//! session's lock flag (`WTSSessionInfoEx`); Linux asks logind through
//! `loginctl` (best effort: `LockedHint` is only kept by desktops that set
//! it). Everything platform-independent (payload, change detection, the
//! post schedule, parsing) is unit-tested below.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// How often the person's state is read. Lock changes are posted the moment
/// a read sees one, so this is also how quickly a lock reaches the sidecar.
/// Linux spawns `loginctl` per read, so it reads less often.
#[cfg(any(target_os = "macos", windows))]
const SAMPLE_EVERY: Duration = Duration::from_secs(1);
#[cfg(not(any(target_os = "macos", windows)))]
const SAMPLE_EVERY: Duration = Duration::from_secs(5);

/// The regular report cadence, matching the shell's other sidecar polls. The
/// sidecar calls a report stale after 30 s.
const REPORT_EVERY: Duration = Duration::from_secs(5);

/// One reading. `None` is "this platform can't say".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PresenceSample {
    pub(super) locked: Option<bool>,
    pub(super) idle_seconds: Option<u64>,
}

/// The wire body of `POST /settings/api/presence`. These three fields are
/// everything that is ever sent.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PresencePayload {
    locked: Option<bool>,
    idle_seconds: Option<u64>,
    at: String,
}

pub(super) fn build_payload(sample: PresenceSample, at: SystemTime) -> PresencePayload {
    let secs = at.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    PresencePayload {
        locked: sample.locked,
        idle_seconds: sample.idle_seconds,
        at: format_iso8601(secs),
    }
}

/// `2026-11-11T10:00:00Z` for Unix seconds (UTC, civil-from-days).
fn format_iso8601(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// Notices when the lock state changes between readings. Idle time moving is
/// not a change, and a platform that can't tell never changes.
#[derive(Debug, Default)]
pub(super) struct LockTracker {
    last: Option<bool>,
}

impl LockTracker {
    /// True when `locked` is a known state that differs from the last known
    /// one (the first known reading counts).
    pub(super) fn observe(&mut self, locked: Option<bool>) -> bool {
        let Some(now) = locked else {
            return false;
        };
        let changed = self.last != Some(now);
        self.last = Some(now);
        changed
    }
}

/// Whether to post now: a lock change not yet delivered, or the regular
/// cadence has come round (`since_last_post` is None before the first post).
fn should_post(pending_change: bool, since_last_post: Option<Duration>) -> bool {
    pending_change || since_last_post.is_none_or(|elapsed| elapsed >= REPORT_EVERY)
}

/// Reports presence until `keep_going` says stop. A failed post is retried on
/// the next reading (a lock change stays pending until one gets through).
pub(super) async fn report_loop(
    client: reqwest::Client,
    url: String,
    api_key: String,
    keep_going: impl Fn() -> bool,
) {
    let mut tracker = LockTracker::default();
    let mut pending = false;
    let mut last_post: Option<Instant> = None;
    while keep_going() {
        let sample = tauri::async_runtime::spawn_blocking(read_sample)
            .await
            .unwrap_or(PresenceSample {
                locked: None,
                idle_seconds: None,
            });
        pending |= tracker.observe(sample.locked);
        if should_post(pending, last_post.map(|t| t.elapsed())) {
            let body = build_payload(sample, SystemTime::now());
            let sent = client
                .post(&url)
                .header("x-api-key", &api_key)
                .json(&body)
                .send()
                .await
                .is_ok_and(|resp| resp.status().is_success());
            if sent {
                pending = false;
                last_post = Some(Instant::now());
            }
        }
        tokio::time::sleep(SAMPLE_EVERY).await;
    }
}

/// Reads the platform's lock state and idle time. Blocking (a syscall, or a
/// process on Linux), so call it off the async threads.
fn read_sample() -> PresenceSample {
    platform::read()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::PresenceSample;
    use std::ffi::{c_char, c_void};

    // kCGEventSourceStateCombinedSessionState and kCGAnyInputEventType: idle
    // time across every input device in the login session.
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    pub(super) fn read() -> PresenceSample {
        PresenceSample {
            locked: locked(),
            idle_seconds: idle_seconds(),
        }
    }

    fn idle_seconds() -> Option<u64> {
        // SAFETY: a plain query with constant arguments.
        let secs = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT_TYPE)
        };
        (secs.is_finite() && secs >= 0.0).then_some(secs as u64)
    }

    /// `CGSSessionScreenIsLocked` is present in the session dictionary only
    /// while the screen is locked. No dictionary (no login session, e.g. over
    /// SSH) means unknown.
    fn locked() -> Option<bool> {
        // SAFETY: every CF object created here is released before returning;
        // the dictionary and the key outlive the lookup, and the looked-up
        // value is borrowed from the dictionary (Get rule), never released.
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return None;
            }
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                CF_STRING_ENCODING_UTF8,
            );
            if key.is_null() {
                CFRelease(dict);
                return None;
            }
            let value = CFDictionaryGetValue(dict, key);
            let locked = if value.is_null() {
                false
            } else if CFGetTypeID(value) == CFBooleanGetTypeID() {
                CFBooleanGetValue(value) != 0
            } else {
                // Present but not a boolean: the key's presence is the signal.
                true
            };
            CFRelease(key);
            CFRelease(dict);
            Some(locked)
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::PresenceSample;
    use windows::core::PWSTR;
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
    };
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub(super) fn read() -> PresenceSample {
        PresenceSample {
            locked: locked(),
            idle_seconds: idle_seconds(),
        }
    }

    fn idle_seconds() -> Option<u64> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a correctly sized, initialised LASTINPUTINFO.
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return None;
        }
        // Both are 32-bit millisecond tick counts that wrap together.
        let idle_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
        Some(u64::from(idle_ms / 1_000))
    }

    /// The session's lock flag, polled (the equivalent of listening for
    /// `WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`, without a message window).
    fn locked() -> Option<bool> {
        let mut buffer = PWSTR::null();
        let mut bytes = 0u32;
        // SAFETY: on success the call hands back a buffer we free below; it
        // holds a WTSINFOEXW only after the size check.
        unsafe {
            WTSQuerySessionInformationW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &mut buffer,
                &mut bytes,
            )
            .ok()?;
            let locked = if buffer.is_null() || (bytes as usize) < std::mem::size_of::<WTSINFOEXW>()
            {
                None
            } else {
                let info = &*(buffer.0 as *const WTSINFOEXW);
                // Level 1 is the only level defined.
                (info.Level == 1)
                    .then(|| info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32)
            };
            if !buffer.is_null() {
                WTSFreeMemory(buffer.0.cast());
            }
            locked
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::{parse_logind, PresenceSample};
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Best effort through logind: `loginctl show-session` for this session's
    /// `LockedHint`, `IdleHint` and `IdleSinceHint`. Anything missing (no
    /// systemd, no session, a desktop that doesn't set the hints) is unknown.
    pub(super) fn read() -> PresenceSample {
        let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "auto".to_owned());
        let output = Command::new("loginctl")
            .args([
                "show-session",
                &session,
                "-p",
                "LockedHint",
                "-p",
                "IdleHint",
                "-p",
                "IdleSinceHint",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let Ok(output) = output else {
            return PresenceSample {
                locked: None,
                idle_seconds: None,
            };
        };
        if !output.status.success() {
            return PresenceSample {
                locked: None,
                idle_seconds: None,
            };
        }
        let now_usec = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as u64);
        parse_logind(&String::from_utf8_lossy(&output.stdout), now_usec)
    }
}

/// Reads `loginctl show-session` output. `LockedHint=yes|no` is the lock
/// state. Idle time is only known while `IdleHint=yes`, as the time since
/// `IdleSinceHint` (microseconds since the epoch); logind keeps no running
/// idle counter otherwise. Not Linux-only so it is tested everywhere.
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn parse_logind(output: &str, now_usec: u64) -> PresenceSample {
    let mut locked = None;
    let mut idle = false;
    let mut idle_since = 0u64;
    for line in output.lines() {
        match line.split_once('=') {
            Some(("LockedHint", v)) => locked = parse_yes_no(v),
            Some(("IdleHint", v)) => idle = parse_yes_no(v) == Some(true),
            Some(("IdleSinceHint", v)) => idle_since = v.trim().parse().unwrap_or(0),
            _ => {}
        }
    }
    let idle_seconds = (idle && idle_since > 0 && now_usec >= idle_since)
        .then(|| (now_usec - idle_since) / 1_000_000);
    PresenceSample {
        locked,
        idle_seconds,
    }
}

#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn parse_yes_no(value: &str) -> Option<bool> {
    match value.trim() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: PresenceSample = PresenceSample {
        locked: Some(false),
        idle_seconds: Some(7),
    };

    #[test]
    fn payload_has_exactly_the_three_wire_fields() {
        let at = UNIX_EPOCH + Duration::from_secs(1_794_391_200);
        let value = serde_json::to_value(build_payload(KNOWN, at)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "locked": false,
                "idleSeconds": 7,
                "at": "2026-11-11T10:00:00Z",
            })
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
    }

    #[test]
    fn payload_sends_null_for_what_the_platform_cannot_say() {
        let unknown = PresenceSample {
            locked: None,
            idle_seconds: None,
        };
        let value = serde_json::to_value(build_payload(unknown, UNIX_EPOCH)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "locked": null,
                "idleSeconds": null,
                "at": "1970-01-01T00:00:00Z",
            })
        );
    }

    #[test]
    fn timestamps_handle_leap_days_and_year_ends() {
        assert_eq!(format_iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_iso8601(1_709_164_799), "2024-02-28T23:59:59Z");
        assert_eq!(format_iso8601(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(format_iso8601(1_798_761_599), "2026-12-31T23:59:59Z");
        assert_eq!(format_iso8601(1_798_761_600), "2027-01-01T00:00:00Z");
    }

    #[test]
    fn first_known_lock_state_is_a_change() {
        let mut tracker = LockTracker::default();
        assert!(tracker.observe(Some(false)));
        assert!(!tracker.observe(Some(false)));
    }

    #[test]
    fn lock_and_unlock_are_changes() {
        let mut tracker = LockTracker::default();
        tracker.observe(Some(false));
        assert!(tracker.observe(Some(true)));
        assert!(!tracker.observe(Some(true)));
        assert!(tracker.observe(Some(false)));
    }

    #[test]
    fn unknown_is_never_a_change_and_does_not_reset_the_state() {
        let mut tracker = LockTracker::default();
        assert!(!tracker.observe(None));
        tracker.observe(Some(true));
        assert!(!tracker.observe(None));
        assert!(!tracker.observe(Some(true)));
    }

    #[test]
    fn posts_on_the_first_reading_then_every_five_seconds() {
        assert!(should_post(false, None));
        assert!(!should_post(false, Some(Duration::from_secs(1))));
        assert!(!should_post(false, Some(Duration::from_millis(4_999))));
        assert!(should_post(false, Some(Duration::from_secs(5))));
    }

    #[test]
    fn a_pending_lock_change_posts_at_once() {
        assert!(should_post(true, Some(Duration::from_millis(1))));
    }

    #[test]
    fn logind_locked_session_that_is_idle() {
        let out = "LockedHint=yes\nIdleHint=yes\nIdleSinceHint=1000000000\n";
        assert_eq!(
            parse_logind(out, 1_000_000_000 + 90 * 1_000_000),
            PresenceSample {
                locked: Some(true),
                idle_seconds: Some(90),
            }
        );
    }

    #[test]
    fn logind_active_session_has_no_idle_time() {
        let out = "LockedHint=no\nIdleHint=no\nIdleSinceHint=0\n";
        assert_eq!(
            parse_logind(out, 5_000_000),
            PresenceSample {
                locked: Some(false),
                idle_seconds: None,
            }
        );
    }

    #[test]
    fn logind_missing_or_odd_values_are_unknown() {
        assert_eq!(
            parse_logind("", 1),
            PresenceSample {
                locked: None,
                idle_seconds: None,
            }
        );
        assert_eq!(parse_logind("LockedHint=maybe\n", 1).locked, None);
        // A hint timestamp in the future never yields a negative idle time.
        let out = "IdleHint=yes\nIdleSinceHint=9000000\n";
        assert_eq!(parse_logind(out, 1_000_000).idle_seconds, None);
    }

    /// Reads the real OS. Manual (`cargo test -- --ignored presence`): it
    /// needs a login session, which CI runners may not have.
    #[test]
    #[ignore = "reads the live session"]
    fn reads_the_live_session() {
        let sample = read_sample();
        eprintln!("live presence: {sample:?}");
        assert!(sample.idle_seconds.is_some());
    }
}
