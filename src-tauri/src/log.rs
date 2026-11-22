//! A small log for crashes and connection events, kept next to Tusk's
//! settings (`%APPDATA%\dev.tusk.app` on Windows).
//!
//! - `tusk.log`: one line per event (start, VPN and remote desktop
//!   connects and disconnects, errors). Rolls over to `tusk.log.1` at 1 MB.
//! - `crash.log`: every crash in full, with the message, where in the code
//!   it happened and a backtrace. Also copied into `tusk.log`, so the lines
//!   before it show what was going on.
//!
//! Release builds abort on a panic and have no console, so without this a
//! crash leaves nothing behind.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG: u64 = 1024 * 1024;
const MAX_CRASH: u64 = 4 * 1024 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());

/// Where the log files are.
pub fn dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

/// Opens the log and starts catching crashes. Call once, first thing.
pub fn init() {
    let Some(dir) = dirs::config_dir().map(|d| d.join("dev.tusk.app")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);

    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let place = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_else(|| "unknown place".into());
        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("unnamed");
        let backtrace = std::backtrace::Backtrace::force_capture();
        crash(&format!("Panic on thread '{thread}' at {place}: {message}"), &backtrace.to_string());
        default(info);
    }));
    #[cfg(windows)]
    native::install();

    info(&format!("Tusk {} started ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));
}

/// Writes one event line.
pub fn info(line: &str) {
    write("INFO", line);
}

/// Writes one error line.
pub fn error(line: &str) {
    write("ERROR", line);
}

fn write(level: &str, line: &str) {
    let Some(dir) = dir() else { return };
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("tusk.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG) {
        let _ = std::fs::rename(&path, dir.join("tusk.log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {level:<5} {}", now(), line.replace('\n', " | "));
    }
}

/// Records a crash in both files.
fn crash(summary: &str, detail: &str) {
    write("CRASH", summary);
    let Some(dir) = dir() else { return };
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("crash.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_CRASH) {
        let _ = std::fs::rename(&path, dir.join("crash.log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "==== {} · Tusk {} ====\n{summary}\n{detail}\n", now(), env!("CARGO_PKG_VERSION"));
        let _ = f.sync_all();
    }
}

/// UTC time as `2026-11-22 14:03:07Z`.
fn now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days as i64);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 to (year, month, day).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Crashes outside Rust's own checks (an access violation in native code,
/// a stack overflow): Windows hands them to this filter before ending Tusk.
#[cfg(windows)]
mod native {
    use windows_sys::Win32::System::Diagnostics::Debug::{SetUnhandledExceptionFilter, EXCEPTION_POINTERS};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;

    unsafe extern "system" fn filter(info: *const EXCEPTION_POINTERS) -> i32 {
        // SAFETY: Windows passes valid exception pointers to this filter.
        let (code, addr) = unsafe {
            match info.as_ref().and_then(|p| p.ExceptionRecord.as_ref()) {
                Some(r) => (r.ExceptionCode as u32, r.ExceptionAddress as usize),
                None => (0, 0),
            }
        };
        // SAFETY: a null name asks for tusk.exe's own module.
        let base = unsafe { GetModuleHandleW(std::ptr::null()) } as usize;
        let what = match code {
            0xc000_0005 => " (access violation)",
            0xc000_00fd => " (stack overflow)",
            0xc000_001d => " (illegal instruction)",
            0xc000_0094 => " (divide by zero)",
            _ => "",
        };
        let place = if base != 0 && addr >= base { format!("tusk.exe+0x{:x}", addr - base) } else { format!("0x{addr:x}") };
        super::crash(&format!("Native crash: exception 0x{code:08x}{what} at {place}"), "");
        0 // EXCEPTION_CONTINUE_SEARCH: let Windows end the process as usual.
    }

    pub fn install() {
        // SAFETY: installs a process-wide filter; `filter` lives forever.
        unsafe {
            SetUnhandledExceptionFilter(Some(filter));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::civil;

    #[test]
    fn dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_414), (2025, 11, 22));
        assert_eq!(civil(11_016), (2000, 2, 29));
    }
}
