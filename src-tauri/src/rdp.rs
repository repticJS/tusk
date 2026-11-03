//! Remote desktop (RDP) sessions shown in a Tusk tab. IronRDP does the
//! protocol; the changed parts of the screen go to the tab as raw RGBA.
//!
//! Messages to the tab on its channel:
//! - binary, first byte 1: screen update, u16 count, then per rectangle
//!   x, y, width, height (u16, little-endian) and its RGBA pixels
//! - binary, first byte 2: mouse pointer image, u16 width, height,
//!   hotspot x, hotspot y, then RGBA pixels
//! - JSON events (connected, resized, pointer, closed)
//!
//! A session can move to another window (popped out) and back: the window
//! attaches its own channel and gets the whole screen again. Claude can see
//! and use a session through the same input (see mcp.rs).

use crate::error::{AppError, AppResult};
use crate::store::RdpConfig;
use ironrdp_connector::connection_activation::ConnectionActivationState;
use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{ClientConnector, ConnectionResult, ConnectorErrorKind, ConnectorResult, Credentials, DesktopSize};
use ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::input::fast_path::FastPathInputEvent;
use ironrdp_pdu::rdp::client_info::PerformanceFlags;
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_connector::Sequence as _;
use ironrdp_tokio::{split_tokio_framed, FramedWrite, NetworkClient};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{mpsc, oneshot};

type Framed = ironrdp_tokio::TokioFramed<ironrdp_tls::TlsStream<tokio::net::TcpStream>>;

/// Batches screen updates: at most this often.
const FLUSH_EVERY: Duration = Duration::from_millis(16);

// ---- input from the tab ----

/// One input event from the tab, in remote desktop pixels.
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "t")]
pub enum InputEvent {
    #[serde(rename = "m")]
    Move { x: u16, y: u16 },
    /// Button as in the web's MouseEvent.button (0 left, 1 middle, 2 right, 3/4 back/forward).
    #[serde(rename = "b")]
    Button { button: u8, down: bool },
    /// Wheel units: 120 per notch, positive away from the user.
    #[serde(rename = "w")]
    Wheel { delta: i16, horizontal: bool },
    /// Scancode (set 1), with 0xE000 for extended keys.
    #[serde(rename = "k")]
    Key { code: u16, down: bool },
    /// Text that has no key on this keyboard layout.
    #[serde(rename = "u")]
    Unicode { ch: char, down: bool },
}

enum Input {
    Events(Vec<InputEvent>),
    Resize { width: u16, height: u16, scale: u32 },
    /// Lets go of every key and button (the tab lost focus).
    ReleaseAll,
    /// Screen updates go to this channel from now on (another window).
    Attach(Channel<InvokeResponseBody>),
    /// A copy of the whole screen.
    Capture(oneshot::Sender<Frame>),
    Close,
    #[cfg(windows)]
    Clipboard(ironrdp_cliprdr::backend::ClipboardMessage),
}

/// The whole screen, RGBA, rows packed.
pub struct Frame {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

/// A connected session.
#[derive(Clone)]
struct Handle {
    tx: mpsc::UnboundedSender<Input>,
    conn_id: String,
    /// The remote desktop's current size.
    size: Arc<Mutex<(u16, u16)>>,
}

#[derive(Default)]
pub struct RdpSessions {
    sessions: Mutex<HashMap<String, Handle>>,
    /// Passwords typed at a prompt, kept for this run of the app only.
    pub passwords: Mutex<HashMap<String, String>>,
}

impl RdpSessions {
    fn send(&self, id: &str, input: Input) -> bool {
        match self.sessions.lock().unwrap().get(id) {
            Some(h) => h.tx.send(input).is_ok(),
            None => false,
        }
    }

    /// Sends the screen to another window's channel (false: no such session).
    pub fn attach(&self, id: &str, events: Channel<InvokeResponseBody>) -> bool {
        self.send(id, Input::Attach(events))
    }

    /// The saved connection a session belongs to.
    pub fn conn_of(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|h| h.conn_id.clone())
    }

    /// A connected session of this saved connection, if any.
    pub fn session_for(&self, conn_id: &str) -> Option<String> {
        let map = self.sessions.lock().unwrap();
        let mut ids: Vec<&String> = map.iter().filter(|(_, h)| h.conn_id == conn_id).map(|(id, _)| id).collect();
        ids.sort();
        ids.first().map(|s| s.to_string())
    }

    /// The remote desktop's size in pixels.
    pub fn size(&self, id: &str) -> Option<(u16, u16)> {
        self.sessions.lock().unwrap().get(id).map(|h| *h.size.lock().unwrap())
    }

    /// The whole screen as it is now.
    pub async fn capture(&self, id: &str) -> Option<Frame> {
        let (tx, rx) = oneshot::channel();
        if !self.send(id, Input::Capture(tx)) {
            return None;
        }
        tokio::time::timeout(Duration::from_secs(10), rx).await.ok()?.ok()
    }

    /// False when the session has ended.
    pub fn input(&self, id: &str, events: Vec<InputEvent>) -> bool {
        self.send(id, Input::Events(events))
    }

    pub fn resize(&self, id: &str, width: u16, height: u16, scale: u32) {
        self.send(id, Input::Resize { width, height, scale });
    }

    pub fn release_all(&self, id: &str) {
        self.send(id, Input::ReleaseAll);
    }

    pub fn close(&self, id: &str) {
        if let Some(h) = self.sessions.lock().unwrap().remove(id) {
            let _ = h.tx.send(Input::Close);
        }
    }
}

// ---- events to the tab ----

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RdpEvent {
    Connected { width: u16, height: u16 },
    Resized { width: u16, height: u16 },
    /// "default" or "hidden" (a pointer image comes as binary).
    Pointer { kind: &'static str },
    Closed { reason: Option<String> },
}

fn json(e: &RdpEvent) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(e).unwrap_or_else(|_| "null".into()))
}

/// The pixels of some rectangles of the screen (alpha forced opaque).
fn encode_rects(image: &DecodedImage, rects: &[InclusiveRectangle]) -> Vec<u8> {
    let (iw, ih) = (image.width() as usize, image.height() as usize);
    let stride = image.stride();
    let data = image.data();
    let mut out = Vec::with_capacity(3 + rects.len() * 8);
    out.push(1);
    let mut count = 0u16;
    out.extend_from_slice(&[0, 0]);
    for r in rects {
        let (x, y) = (r.left as usize, r.top as usize);
        if x >= iw || y >= ih {
            continue;
        }
        let w = (r.right as usize + 1).min(iw).saturating_sub(x);
        let h = (r.bottom as usize + 1).min(ih).saturating_sub(y);
        if w == 0 || h == 0 {
            continue;
        }
        for v in [x, y, w, h] {
            out.extend_from_slice(&(v as u16).to_le_bytes());
        }
        out.reserve(w * h * 4);
        for row in y..y + h {
            let start = row * stride + x * 4;
            let line = &data[start..start + w * 4];
            let at = out.len();
            out.extend_from_slice(line);
            for a in out[at..].iter_mut().skip(3).step_by(4) {
                *a = 255;
            }
        }
        count += 1;
    }
    out[1..3].copy_from_slice(&count.to_le_bytes());
    out
}

/// Whole-screen rectangle.
fn full(image: &DecodedImage) -> InclusiveRectangle {
    InclusiveRectangle { left: 0, top: 0, right: image.width().saturating_sub(1), bottom: image.height().saturating_sub(1) }
}

/// Pending screen updates; many small ones become one bounding box.
#[derive(Default)]
struct Dirty(Vec<InclusiveRectangle>);

impl Dirty {
    fn add(&mut self, r: InclusiveRectangle) {
        self.0.push(r);
        if self.0.len() > 24 {
            let b = self.0.iter().fold(self.0[0].clone(), |a, r| InclusiveRectangle {
                left: a.left.min(r.left),
                top: a.top.min(r.top),
                right: a.right.max(r.right),
                bottom: a.bottom.max(r.bottom),
            });
            self.0 = vec![b];
        }
    }
}

fn encode_pointer(p: &ironrdp_graphics::pointer::DecodedPointer) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + p.bitmap_data.len());
    out.push(2);
    for v in [p.width, p.height, p.hotspot_x, p.hotspot_y] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&p.bitmap_data);
    out
}

/// The mouse pointer as last shown, to show again in a window that attaches.
enum LastPointer {
    Default,
    Hidden,
    Bitmap(Vec<u8>),
}

impl LastPointer {
    fn message(&self) -> InvokeResponseBody {
        match self {
            LastPointer::Default => json(&RdpEvent::Pointer { kind: "default" }),
            LastPointer::Hidden => json(&RdpEvent::Pointer { kind: "hidden" }),
            LastPointer::Bitmap(b) => InvokeResponseBody::Raw(b.clone()),
        }
    }
}

/// A packed copy of the screen (alpha forced opaque).
fn frame(image: &DecodedImage) -> Frame {
    let (w, h) = (image.width() as usize, image.height() as usize);
    let stride = image.stride();
    let data = image.data();
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let start = row * stride;
        rgba.extend_from_slice(&data[start..start + w * 4]);
    }
    for a in rgba.iter_mut().skip(3).step_by(4) {
        *a = 255;
    }
    Frame { width: image.width(), height: image.height(), rgba }
}

// ---- screenshots for Claude ----

/// The size a screenshot of a `width`×`height` screen is shown at: within
/// `max_w`×`max_h`, never enlarged.
pub fn shot_size(width: u16, height: u16, max_w: u32, max_h: u32) -> (u32, u32) {
    let (w, h) = (u32::from(width.max(1)), u32::from(height.max(1)));
    let f = (f64::from(max_w) / f64::from(w)).min(f64::from(max_h) / f64::from(h)).min(1.0);
    (((f64::from(w) * f).round() as u32).max(1), ((f64::from(h) * f).round() as u32).max(1))
}

/// Shrinks the screen to `tw`×`th` (each pixel the average of the ones it
/// covers) and encodes it as an RGB PNG.
pub fn screenshot_png(f: &Frame, tw: u32, th: u32) -> Result<Vec<u8>, String> {
    let (sw, sh) = (f.width as usize, f.height as usize);
    let (tw, th) = (tw as usize, th as usize);
    let mut rgb = Vec::with_capacity(tw * th * 3);
    for ty in 0..th {
        let y0 = ty * sh / th;
        let y1 = ((ty + 1) * sh / th).max(y0 + 1).min(sh);
        for tx in 0..tw {
            let x0 = tx * sw / tw;
            let x1 = ((tx + 1) * sw / tw).max(x0 + 1).min(sw);
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                let row = &f.rgba[(y * sw + x0) * 4..(y * sw + x1) * 4];
                for p in row.chunks_exact(4) {
                    sum[0] += u32::from(p[0]);
                    sum[1] += u32::from(p[1]);
                    sum[2] += u32::from(p[2]);
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            rgb.extend(sum.iter().map(|s| (s / n) as u8));
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, tw as u32, th as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Key names Claude uses ("ctrl", "enter", "f4", "a"…) as set-1 scancodes.
pub fn key_code(name: &str) -> Option<u16> {
    let n = name.trim().to_lowercase();
    let n = if n.chars().count() > 1 { n.replace(['_', ' '], "") } else { n };
    Some(match n.as_str() {
        "ctrl" | "control" | "lctrl" | "ctrlleft" | "controlleft" => 0x1d,
        "rctrl" | "ctrlright" | "controlright" => 0xe01d,
        "shift" | "lshift" | "shiftleft" => 0x2a,
        "rshift" | "shiftright" => 0x36,
        "alt" | "lalt" | "altleft" | "option" => 0x38,
        "ralt" | "altright" | "altgr" => 0xe038,
        "win" | "windows" | "super" | "meta" | "cmd" | "command" | "start" | "lwin" | "metaleft" => 0xe05b,
        "rwin" | "metaright" => 0xe05c,
        "enter" | "return" | "kpenter" => 0x1c,
        "esc" | "escape" => 0x01,
        "tab" => 0x0f,
        "backspace" | "back" => 0x0e,
        "delete" | "del" => 0xe053,
        "insert" | "ins" => 0xe052,
        "home" => 0xe047,
        "end" => 0xe04f,
        "pageup" | "pgup" | "prior" => 0xe049,
        "pagedown" | "pgdn" | "next" => 0xe051,
        "up" | "arrowup" => 0xe048,
        "down" | "arrowdown" => 0xe050,
        "left" | "arrowleft" => 0xe04b,
        "right" | "arrowright" => 0xe04d,
        "space" | "spacebar" | " " => 0x39,
        "capslock" | "caps" => 0x3a,
        "numlock" => 0x45,
        "scrolllock" => 0x46,
        "printscreen" | "print" | "prtsc" | "prtscn" => 0xe037,
        "menu" | "apps" | "contextmenu" => 0xe05d,
        "-" | "minus" => 0x0c,
        "=" | "equal" | "equals" => 0x0d,
        "[" | "bracketleft" => 0x1a,
        "]" | "bracketright" => 0x1b,
        ";" | "semicolon" => 0x27,
        "'" | "quote" | "apostrophe" => 0x28,
        "`" | "grave" | "backquote" => 0x29,
        "\\" | "backslash" => 0x2b,
        "," | "comma" => 0x33,
        "." | "period" => 0x34,
        "/" | "slash" => 0x35,
        _ => {
            if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()) {
                return match f {
                    1..=10 => Some(0x3a + f),
                    11 => Some(0x57),
                    12 => Some(0x58),
                    13..=23 => Some(0x64 + f - 13),
                    24 => Some(0x76),
                    _ => None,
                };
            }
            let mut chars = n.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return None };
            const ROWS: [(&str, u16); 3] = [("qwertyuiop", 0x10), ("asdfghjkl", 0x1e), ("zxcvbnm", 0x2c)];
            if let Some(code) = ROWS.iter().find_map(|(row, base)| row.find(c).map(|i| base + i as u16)) {
                return Some(code);
            }
            return match c {
                '1'..='9' => Some(0x02 + (c as u16 - '1' as u16)),
                '0' => Some(0x0b),
                _ => None,
            };
        }
    })
}

/// "ctrl+shift+esc alt+f4" → presses: each combination held down in order
/// and let go in reverse.
pub fn key_events(keys: &str) -> Result<Vec<InputEvent>, String> {
    let mut out = Vec::new();
    for combo in keys.split_whitespace() {
        // "ctrl++" means ctrl and the plus key, which isn't a key of its own.
        let parts: Vec<&str> = combo.split('+').filter(|p| !p.is_empty()).collect();
        let mut codes = Vec::new();
        for p in &parts {
            codes.push(key_code(p).ok_or_else(|| format!("Unknown key \"{p}\"; use names like ctrl, alt, shift, win, enter, esc, tab, f4, a, 1"))?);
        }
        out.extend(codes.iter().map(|&code| InputEvent::Key { code, down: true }));
        out.extend(codes.iter().rev().map(|&code| InputEvent::Key { code, down: false }));
    }
    if out.is_empty() {
        return Err("No keys given".into());
    }
    Ok(out)
}

/// Text as key presses: Enter and Tab as keys, everything else as Unicode.
pub fn text_events(text: &str) -> Vec<InputEvent> {
    let mut out = Vec::new();
    for ch in text.chars() {
        match ch {
            '\r' => {}
            '\n' => out.extend([InputEvent::Key { code: 0x1c, down: true }, InputEvent::Key { code: 0x1c, down: false }]),
            '\t' => out.extend([InputEvent::Key { code: 0x0f, down: true }, InputEvent::Key { code: 0x0f, down: false }]),
            c => out.extend([InputEvent::Unicode { ch: c, down: true }, InputEvent::Unicode { ch: c, down: false }]),
        }
    }
    out
}

// ---- connecting ----

/// CredSSP's Kerberos needs a network client; Tusk signs in with NTLM.
struct NoNetwork;

impl NetworkClient for NoNetwork {
    async fn send(&mut self, _request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(ironrdp_connector::general_err!("Kerberos sign-in isn't supported; use a password the computer accepts with NTLM"))
    }
}

pub struct OpenRequest {
    pub session_id: String,
    pub config: RdpConfig,
    pub password: Option<String>,
    pub accept_fingerprint: Option<String>,
    pub width: u16,
    pub height: u16,
    /// Desktop scale in percent (100 = no scaling).
    pub scale: u32,
    pub known_hosts: PathBuf,
}

/// The local keyboard layout, so keys mean the same on the remote desktop.
fn keyboard_layout() -> u32 {
    #[cfg(windows)]
    {
        // SAFETY: plain query of the current thread's layout.
        let hkl = unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout(0) };
        (hkl as usize & 0xFFFF) as u32
    }
    #[cfg(not(windows))]
    {
        0x409
    }
}

fn connector_config(c: &RdpConfig, password: &str, size: DesktopSize, scale: u32) -> ironrdp_connector::Config {
    let codecs = ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&[]).unwrap_or_default();
    let performance_flags = if c.performance == "fast" {
        PerformanceFlags::DISABLE_WALLPAPER
            | PerformanceFlags::DISABLE_FULLWINDOWDRAG
            | PerformanceFlags::DISABLE_MENUANIMATIONS
            | PerformanceFlags::DISABLE_THEMING
            | PerformanceFlags::DISABLE_CURSOR_SHADOW
    } else {
        PerformanceFlags::ENABLE_FONT_SMOOTHING | PerformanceFlags::ENABLE_DESKTOP_COMPOSITION
    };
    let host_name = hostname();
    ironrdp_connector::Config {
        desktop_size: size,
        desktop_scale_factor: if scale > 100 { scale } else { 0 },
        enable_tls: true,
        enable_credssp: true,
        enable_standard_rdp_security: false,
        monitor_layout: None,
        connection_type: ironrdp_pdu::gcc::ConnectionType::Lan,
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
        enable_audio_capture: false,
        support_dyn_vc_gfx_protocol: false,
        credentials: Credentials::UsernamePassword { username: c.user.trim().to_string(), password: password.to_string() },
        domain: Some(c.domain.trim().to_string()).filter(|d| !d.is_empty()),
        // Servers treat build 419 and below as clients that can't resize.
        client_build: 22621,
        client_name: host_name,
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: keyboard_layout(),
        ime_file_name: String::new(),
        bitmap: Some(ironrdp_connector::BitmapConfig {
            lossy_compression: true,
            color_depth: if c.color_depth == 16 { 16 } else { 32 },
            codecs,
        }),
        dig_product_id: String::new(),
        client_dir: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS,
        hardware_id: None,
        request_data: None,
        autologon: !password.is_empty(),
        enable_audio_playback: c.sound,
        performance_flags,
        license_cache: None,
        timezone_info: Default::default(),
        compression_type: Some(ironrdp_pdu::rdp::client_info::CompressionType::K64),
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "tusk".into())
        .chars()
        .take(15)
        .collect()
}

/// RDP needs an even width within 200..8192; some servers (xrdp) only
/// resize to widths that are a multiple of 4.
fn adjust(width: u16, height: u16) -> DesktopSize {
    let (w, h) = MonitorLayoutEntry::adjust_display_size(u32::from(width), u32::from(height));
    DesktopSize { width: (w as u16) & !3, height: h as u16 }
}

fn known_hosts(path: &Path) -> HashMap<String, String> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn fingerprint(key: &[u8]) -> String {
    Sha256::digest(key).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Turns an IronRDP failure into something the user can act on.
fn connect_error(e: ironrdp_connector::ConnectorError, c: &RdpConfig) -> AppError {
    match e.kind() {
        ConnectorErrorKind::Credssp(err) => match err.nstatus.map(|n| n.0) {
            Some(0xC000_006D) | Some(0xC000_006A) | Some(0xC000_0064) => {
                AppError::kind("RDP_AUTH_FAILED", "The user name or password is incorrect.")
            }
            Some(0xC000_0234) => AppError::msg("This account is locked out."),
            Some(0xC000_0072) => AppError::msg("This account is disabled."),
            Some(0xC000_0193) => AppError::msg("This account has expired."),
            Some(0xC000_0071) | Some(0xC000_0224) => {
                AppError::msg("The password has expired or must be changed. Change it on the computer, then connect again.")
            }
            Some(0xC000_006E) | Some(0xC000_006F) | Some(0xC000_0070) => {
                AppError::msg("This account isn't allowed to sign in to this computer right now.")
            }
            _ => AppError::msg(format!("Network Level Authentication failed: {}", err.description)),
        },
        ConnectorErrorKind::Negotiation(f) => AppError::msg(format!("The computer refused the connection: {f}")),
        ConnectorErrorKind::AccessDenied => AppError::msg(format!("Access denied for {}", c.user)),
        _ => AppError::msg(format!("Remote desktop connection failed: {}", e.report())),
    }
}

/// Connects, checks the computer's certificate and signs in.
async fn connect(
    c: &RdpConfig,
    password: &str,
    size: DesktopSize,
    scale: u32,
    accept: Option<&str>,
    known_path: &Path,
    clipboard: Option<Box<dyn ironrdp_cliprdr::backend::CliprdrBackend>>,
) -> AppResult<(ConnectionResult, Framed)> {
    let target = format!("{}:{}", c.host.trim(), c.port);
    let stream = tokio::time::timeout(Duration::from_secs(15), tokio::net::TcpStream::connect(&target))
        .await
        .map_err(|_| AppError::msg(format!("Timed out connecting to {target}")))?
        .map_err(|e| AppError::msg(format!("Could not connect to {target}: {e}")))?;
    let _ = stream.set_nodelay(true);
    let client_addr = stream.local_addr()?;
    let mut framed = ironrdp_tokio::TokioFramed::new(stream);

    let drdynvc = ironrdp_dvc::DrdynvcClient::new()
        .with_dynamic_channel(ironrdp_displaycontrol::client::DisplayControlClient::new(|_| Ok(Vec::new())));
    let mut connector =
        ClientConnector::new(connector_config(c, password, size, scale), client_addr).with_static_channel(drdynvc);
    if c.sound {
        connector = connector.with_static_channel(ironrdp_rdpsnd::client::Rdpsnd::new(Box::new(
            ironrdp_rdpsnd_native::cpal::RdpsndBackend::new(),
        )));
    }
    if let Some(backend) = clipboard {
        connector.attach_static_channel(ironrdp_cliprdr::Cliprdr::new(backend));
    }

    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector).await.map_err(|e| connect_error(e, c))?;
    let (initial, leftover) = framed.into_inner();
    let host = c.host.trim();
    let (tls, cert) = ironrdp_tls::upgrade(initial, host)
        .await
        .map_err(|e| AppError::msg(format!("Secure connection to {target} failed: {e}")))?;
    let key = ironrdp_tls::extract_tls_server_public_key(&cert)
        .ok_or_else(|| AppError::msg("The computer's certificate has no usable key"))?
        .to_owned();

    // Trust on first use, like SSH host keys: the password is only sent
    // once the user has accepted this computer's certificate.
    let fp = fingerprint(&key);
    let mut known = known_hosts(known_path);
    let host_key = target.to_lowercase();
    match known.get(&host_key) {
        Some(k) if *k == fp => {}
        prev if accept == Some(fp.as_str()) => {
            let _ = prev;
            known.insert(host_key, fp.clone());
            std::fs::write(known_path, serde_json::to_vec_pretty(&known)?)?;
        }
        prev => {
            let subject = cert.tbs_certificate().subject().to_string();
            let kind = if prev.is_some() { "RDP_CERT_CHANGED" } else { "RDP_CERT_UNKNOWN" };
            let message = if prev.is_some() {
                format!("The certificate of {target} has changed since you last connected. Someone could be intercepting the connection, or the computer got a new certificate.")
            } else {
                format!("Tusk hasn't connected to {target} before. Check that this certificate belongs to the computer before trusting it.")
            };
            let mut err = AppError::kind(kind, message);
            err.detail = Some(format!("{subject}\nSHA-256 {fp}"));
            err.hint = Some(fp);
            return Err(err);
        }
    }

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_tokio::TokioFramed::new_with_leftover(tls, leftover);
    let result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut NoNetwork,
        ironrdp_connector::ServerName::new(host),
        key,
        None,
    )
    .await
    .map_err(|e| connect_error(e, c))?;
    Ok((result, framed))
}

/// Starts a session: connects (so problems come back to the caller), then
/// runs it in the background until it ends or the tab closes.
pub async fn open(
    app: tauri::AppHandle,
    sessions: std::sync::Arc<RdpSessions>,
    req: OpenRequest,
    events: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let c = req.config;
    let password = req.password.unwrap_or_default();
    if password.is_empty() && !c.user.trim().is_empty() {
        return Err(AppError::kind("RDP_PASSWORD_REQUIRED", format!("Password for {}", c.name)));
    }
    let size = match crate::store::parse_size(&c.size) {
        Some((w, h)) => adjust(w, h),
        None => adjust(req.width, req.height),
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let clipboard = Clipboard::start(&app, c.clipboard, &req.session_id, tx.clone()).await;
    let backend = clipboard.backend();
    let first = match connect(&c, &password, size, req.scale, req.accept_fingerprint.as_deref(), &req.known_hosts, backend).await {
        Ok(r) => r,
        Err(e) => {
            clipboard.stop(&app);
            return Err(e);
        }
    };
    let desk = Arc::new(Mutex::new((first.0.desktop_size.width, first.0.desktop_size.height)));
    let handle = Handle { tx: tx.clone(), conn_id: c.id.clone(), size: desk.clone() };
    if let Some(old) = sessions.sessions.lock().unwrap().insert(req.session_id.clone(), handle) {
        let _ = old.tx.send(Input::Close);
    }
    let id = req.session_id;
    let known_path = req.known_hosts;
    let scale = req.scale;
    tokio::spawn(async move {
        let mut rx = rx;
        let mut events = events;
        let mut next = Some(first);
        let mut size = size;
        let reason = loop {
            let (result, framed) = match next.take() {
                Some(r) => r,
                None => match connect(&c, &password, size, scale, None, &known_path, clipboard.backend()).await {
                    Ok(r) => r,
                    Err(e) => break Some(e.message),
                },
            };
            *desk.lock().unwrap() = (result.desktop_size.width, result.desktop_size.height);
            let _ = events.send(json(&RdpEvent::Connected { width: result.desktop_size.width, height: result.desktop_size.height }));
            match run(framed, result, &mut events, &mut rx, &desk).await {
                Ok(Flow::Reconnect(s)) => size = s,
                Ok(Flow::Ended(reason)) => break reason,
                Err(e) => break Some(e),
            }
        };
        let _ = events.send(json(&RdpEvent::Closed { reason }));
        clipboard.stop(&app);
        // Forget the session unless a newer one took its place.
        let mut map = sessions.sessions.lock().unwrap();
        if map.get(&id).is_some_and(|h| h.tx.same_channel(&tx)) {
            map.remove(&id);
        }
    });
    Ok(())
}

enum Flow {
    /// The server can't resize on the fly; connect again at this size.
    Reconnect(DesktopSize),
    Ended(Option<String>),
}

fn session_err(e: impl std::fmt::Display) -> String {
    format!("Connection lost: {e}")
}

/// The active session: screen updates out, input in.
async fn run(
    framed: Framed,
    result: ConnectionResult,
    events: &mut Channel<InvokeResponseBody>,
    rx: &mut mpsc::UnboundedReceiver<Input>,
    desk: &Mutex<(u16, u16)>,
) -> Result<Flow, String> {
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let size = result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    let activation_factory = result.activation_factory;
    let mut stage: ActiveStage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut input = Database::new();
    let mut dirty = Dirty::default();
    let mut flush = tokio::time::interval(FLUSH_EVERY);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut housekeeping = tokio::time::interval(Duration::from_secs(5));
    // The size last asked for, until the server has switched to it.
    let mut requested: Option<DesktopSize> = None;
    let mut pointer = LastPointer::Default;

    loop {
        let outputs = tokio::select! {
            frame = reader.read_pdu() => {
                let (action, payload) = frame.map_err(session_err)?;
                stage.process(&mut image, action, &payload, reader.last_read_at()).map_err(|e| session_err(e.report()))?
            }
            msg = rx.recv() => match msg {
                None => stage.graceful_shutdown().map_err(session_err)?,
                Some(Input::Events(list)) => {
                    let ops = list.into_iter().filter_map(to_operation);
                    let fast: Vec<FastPathInputEvent> = input.apply(ops).into_iter().collect();
                    if fast.is_empty() { Vec::new() } else { stage.process_fastpath_input(&mut image, &fast).map_err(session_err)? }
                }
                Some(Input::ReleaseAll) => {
                    let fast: Vec<FastPathInputEvent> = input.release_all().into_iter().collect();
                    if fast.is_empty() { Vec::new() } else { stage.process_fastpath_input(&mut image, &fast).map_err(session_err)? }
                }
                Some(Input::Resize { width, height, scale }) => {
                    let s = adjust(width, height);
                    if s.width == image.width() && s.height == image.height() {
                        Vec::new()
                    } else {
                        // Some servers (xrdp) ignore layouts without a scale and a
                        // physical size; give both (the size at the scale's DPI).
                        let scale = scale.clamp(100, 500);
                        let mm = |px: u16| (f64::from(px) * 25.4 * 100.0 / (96.0 * f64::from(scale))).round() as u32;
                        match stage.encode_resize(u32::from(s.width), u32::from(s.height), Some(scale), Some((mm(s.width), mm(s.height)))) {
                            Some(frame) => {
                                requested = Some(s);
                                vec![ActiveStageOutput::ResponseFrame(frame.map_err(session_err)?)]
                            }
                            // No display control channel: connect again at the new size.
                            None => return Ok(Flow::Reconnect(s)),
                        }
                    }
                }
                Some(Input::Attach(ch)) => {
                    // A new window: tell it the size, then show it everything.
                    *events = ch;
                    let _ = events.send(json(&RdpEvent::Connected { width: image.width(), height: image.height() }));
                    let _ = events.send(pointer.message());
                    dirty.0.clear();
                    dirty.add(full(&image));
                    Vec::new()
                }
                Some(Input::Capture(reply)) => {
                    let _ = reply.send(frame(&image));
                    Vec::new()
                }
                Some(Input::Close) => stage.graceful_shutdown().map_err(session_err)?,
                #[cfg(windows)]
                Some(Input::Clipboard(m)) => clipboard_message(&mut stage, m)?,
            },
            _ = flush.tick(), if !dirty.0.is_empty() => {
                let _ = events.send(InvokeResponseBody::Raw(encode_rects(&image, &dirty.0)));
                dirty.0.clear();
                Vec::new()
            }
            _ = housekeeping.tick() => {
                #[cfg(windows)]
                if let Some(c) = stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() {
                    if let Ok(messages) = c.drive_timeouts() {
                        let frame = stage.process_svc_processor_messages(messages).map_err(session_err)?;
                        if !frame.is_empty() {
                            writer.write_all(&frame).await.map_err(session_err)?;
                        }
                    }
                }
                Vec::new()
            }
        };

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => writer.write_all(&frame).await.map_err(session_err)?,
                ActiveStageOutput::GraphicsUpdate(rect) => dirty.add(rect),
                ActiveStageOutput::PointerDefault => {
                    pointer = LastPointer::Default;
                    let _ = events.send(pointer.message());
                }
                ActiveStageOutput::PointerHidden => {
                    pointer = LastPointer::Hidden;
                    let _ = events.send(pointer.message());
                }
                ActiveStageOutput::PointerBitmap(p) => {
                    pointer = LastPointer::Bitmap(encode_pointer(&p));
                    let _ = events.send(pointer.message());
                }
                ActiveStageOutput::DeactivateAll => {
                    // The server changed the session (often its size): run the
                    // Deactivation-Reactivation Sequence and start a new screen.
                    // Servers that get it slightly wrong (xrdp) are reconnected at
                    // the size that was asked for instead.
                    let mut activation = activation_factory.create();
                    let mut buf = WriteBuf::new();
                    let mut deferred = Vec::new();
                    let reactivated = async {
                        loop {
                            let written = reactivation_step(&mut reader, &mut activation, &mut buf, &mut deferred).await?;
                            if written.size().is_some() {
                                writer.write_all(buf.filled()).await.map_err(session_err)?;
                            }
                            if let ConnectionActivationState::Finalized {
                                desktop_size,
                                share_id,
                                enable_server_pointer,
                                pointer_software_rendering,
                                static_channel_chunk_size,
                                window_support_level,
                                ..
                            } = activation.connection_activation_state()
                            {
                                return Ok::<_, String>((
                                    desktop_size,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    static_channel_chunk_size,
                                    window_support_level,
                                ));
                            }
                        }
                    }
                    .await;
                    let (desktop_size, share_id, enable_server_pointer, pointer_software_rendering, chunk_size, window_support_level) =
                        match reactivated {
                            Ok(r) => r,
                            Err(e) => match requested {
                                Some(s) => return Ok(Flow::Reconnect(s)),
                                None => return Err(e),
                            },
                        };
                    requested = None;
                    image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                    if !stage.reactivate(
                        activation.io_channel_id(),
                        activation.user_channel_id(),
                        share_id,
                        enable_server_pointer,
                        pointer_software_rendering,
                        chunk_size,
                    ) {
                        return Err("Connection lost: the server sent an invalid channel size".into());
                    }
                    stage.set_window_support_level(window_support_level);
                    // Channel data that arrived during the sequence.
                    for frame in deferred {
                        for out in stage.process(&mut image, ironrdp_pdu::Action::X224, &frame, None).map_err(|e| session_err(e.report()))? {
                            if let ActiveStageOutput::ResponseFrame(f) = out {
                                writer.write_all(&f).await.map_err(session_err)?;
                            }
                        }
                    }
                    dirty.0.clear();
                    dirty.add(full(&image));
                    *desk.lock().unwrap() = (desktop_size.width, desktop_size.height);
                    let _ = events.send(json(&RdpEvent::Resized { width: desktop_size.width, height: desktop_size.height }));
                }
                ActiveStageOutput::Terminate(reason) => {
                    use ironrdp_session::GracefulDisconnectReason as R;
                    // The user's own disconnect needs no explanation.
                    let text = match reason {
                        R::UserInitiated => None,
                        R::ServerInitiated => Some("The computer ended the session.".to_string()),
                        R::Other(d) => Some(d),
                    };
                    return Ok(Flow::Ended(text));
                }
                _ => {}
            }
        }
    }
}

/// One step of the Deactivation-Reactivation Sequence. Screen updates the
/// server still sends for the old screen are skipped, and virtual channel
/// data (sound, clipboard…) is kept in `deferred` for after the sequence,
/// instead of failing it (FreeRDP's server sends both meanwhile).
async fn reactivation_step<S: ironrdp_tokio::FramedRead>(
    reader: &mut ironrdp_tokio::Framed<S>,
    activation: &mut ironrdp_connector::connection_activation::ConnectionActivationSequence,
    buf: &mut WriteBuf,
    deferred: &mut Vec<ironrdp_tokio::bytes::BytesMut>,
) -> Result<ironrdp_connector::Written, String> {
    buf.clear();
    if activation.next_pdu_hint().is_none() {
        return activation.step_no_input(buf).map_err(session_err);
    }
    loop {
        let (action, payload) = reader.read_pdu().await.map_err(session_err)?;
        if action == ironrdp_pdu::Action::FastPath {
            continue;
        }
        let channel = ironrdp_core::decode::<ironrdp_pdu::x224::X224<ironrdp_pdu::mcs::SendDataIndication<'_>>>(&payload)
            .ok()
            .map(|p| p.0.channel_id);
        if channel.is_some_and(|c| c != activation.io_channel_id()) {
            deferred.push(payload);
            continue;
        }
        return activation.step(&payload, reader.last_read_at(), buf).map_err(|e| session_err(e.report()));
    }
}

fn to_operation(e: InputEvent) -> Option<Operation> {
    Some(match e {
        InputEvent::Move { x, y } => Operation::MouseMove(MousePosition { x, y }),
        InputEvent::Button { button, down } => {
            let b = MouseButton::from_web_button(button)?;
            if down { Operation::MouseButtonPressed(b) } else { Operation::MouseButtonReleased(b) }
        }
        InputEvent::Wheel { delta, horizontal } => {
            Operation::WheelRotations(WheelRotations { is_vertical: !horizontal, rotation_units: delta })
        }
        InputEvent::Key { code, down } => {
            let s = Scancode::from_u16(code);
            if down { Operation::KeyPressed(s) } else { Operation::KeyReleased(s) }
        }
        InputEvent::Unicode { ch, down } => {
            if down { Operation::UnicodeKeyPressed(ch) } else { Operation::UnicodeKeyReleased(ch) }
        }
    })
}

// ---- clipboard (Windows) ----

/// The shared clipboard of one session. On Windows it lives on the main
/// thread, which runs the message loop the clipboard window needs.
struct Clipboard {
    factory: Option<Box<dyn ironrdp_cliprdr::backend::CliprdrBackendFactory + Send>>,
    #[cfg_attr(not(windows), allow(dead_code))]
    id: String,
}

#[cfg(windows)]
thread_local! {
    static WIN_CLIPBOARDS: std::cell::RefCell<HashMap<String, ironrdp_cliprdr_native::WinClipboard>> = Default::default();
}

#[cfg(windows)]
#[derive(Clone, Debug)]
struct ClipboardProxy(mpsc::UnboundedSender<Input>);

#[cfg(windows)]
impl ironrdp_cliprdr::backend::ClipboardMessageProxy for ClipboardProxy {
    fn send_clipboard_message(&self, message: ironrdp_cliprdr::backend::ClipboardMessage) {
        let _ = self.0.send(Input::Clipboard(message));
    }
}

impl Clipboard {
    #[cfg_attr(not(windows), allow(unused_variables))]
    async fn start(app: &tauri::AppHandle, enabled: bool, id: &str, tx: mpsc::UnboundedSender<Input>) -> Self {
        #[cfg(windows)]
        if enabled {
            let (done, wait) = tokio::sync::oneshot::channel();
            let key = id.to_string();
            let ok = app.run_on_main_thread(move || {
                let factory = match ironrdp_cliprdr_native::WinClipboard::new(ClipboardProxy(tx)) {
                    Ok(cb) => {
                        let f = cb.backend_factory();
                        WIN_CLIPBOARDS.with(|m| m.borrow_mut().insert(key, cb));
                        Some(f)
                    }
                    Err(_) => None,
                };
                let _ = done.send(factory);
            });
            if ok.is_ok() {
                if let Ok(factory) = wait.await {
                    return Clipboard { factory, id: id.to_string() };
                }
            }
        }
        Clipboard { factory: None, id: id.to_string() }
    }

    /// A fresh backend for one connection.
    fn backend(&self) -> Option<Box<dyn ironrdp_cliprdr::backend::CliprdrBackend>> {
        self.factory.as_ref().map(|f| f.build_cliprdr_backend())
    }

    #[cfg_attr(not(windows), allow(unused_variables))]
    fn stop(&self, app: &tauri::AppHandle) {
        #[cfg(windows)]
        if self.factory.is_some() {
            let id = self.id.clone();
            let _ = app.run_on_main_thread(move || {
                WIN_CLIPBOARDS.with(|m| m.borrow_mut().remove(&id));
            });
        }
    }
}

#[cfg(windows)]
fn clipboard_message(stage: &mut ActiveStage, m: ironrdp_cliprdr::backend::ClipboardMessage) -> Result<Vec<ActiveStageOutput>, String> {
    use ironrdp_cliprdr::backend::ClipboardMessage as M;
    let Some(c) = stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() else { return Ok(Vec::new()) };
    let messages = match m {
        M::SendInitiateCopy(formats) => c.initiate_copy(&formats),
        M::SendInitiateFileCopy(files) => c.initiate_file_copy(files),
        M::SendFormatData(r) => c.submit_format_data(r),
        M::SendInitiatePaste(f) => c.initiate_paste(f),
        M::SendFileContentsRequest(r) => c.request_file_contents(r),
        M::SendFileContentsResponse(r) => c.submit_file_contents(r),
        M::Error(_) => return Ok(Vec::new()),
    }
    .map_err(session_err)?;
    let frame = stage.process_svc_processor_messages(messages).map_err(session_err)?;
    Ok(vec![ActiveStageOutput::ResponseFrame(frame)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_made_valid() {
        let s = adjust(1001, 700);
        assert_eq!(s.width % 2, 0);
        assert!(adjust(50, 50).width >= 200);
    }

    #[test]
    fn rects_are_cut_from_the_screen() {
        let mut image = DecodedImage::new(PixelFormat::RgbA32, 4, 3);
        let bytes = encode_rects(&image, &[InclusiveRectangle { left: 1, top: 1, right: 2, bottom: 9 }]);
        assert_eq!(bytes[0], 1);
        assert_eq!(u16::from_le_bytes([bytes[1], bytes[2]]), 1);
        let header: Vec<u16> = bytes[3..11].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(header, [1, 1, 2, 2], "clipped to the screen");
        assert_eq!(bytes.len(), 11 + 2 * 2 * 4);
        assert!(bytes[11..].chunks(4).all(|p| p[3] == 255), "opaque");
        let _ = &mut image;
    }

    #[test]
    fn input_maps_to_operations() {
        assert!(matches!(to_operation(InputEvent::Key { code: 0xE04B, down: true }), Some(Operation::KeyPressed(s)) if s.as_u16() == 0xE04B));
        assert!(matches!(to_operation(InputEvent::Button { button: 2, down: false }), Some(Operation::MouseButtonReleased(MouseButton::Right))));
        assert!(to_operation(InputEvent::Button { button: 9, down: true }).is_none());
    }

    #[test]
    fn screenshots_shrink_to_fit() {
        assert_eq!(shot_size(1920, 1080, 1280, 800), (1280, 720));
        assert_eq!(shot_size(1024, 768, 1280, 800), (1024, 768), "never enlarged");
        assert_eq!(shot_size(1280, 1024, 1280, 800), (1000, 800));
        let f = Frame { width: 4, height: 2, rgba: [[255, 0, 0, 255], [0, 0, 255, 255]].repeat(4).concat() };
        let png = screenshot_png(&f, 2, 1).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }

    #[test]
    fn key_names_become_scancodes() {
        assert_eq!(key_code("Ctrl"), Some(0x1d));
        assert_eq!(key_code("Return"), Some(0x1c));
        assert_eq!(key_code("Page_Up"), Some(0xe049));
        assert_eq!(key_code("f4"), Some(0x3e));
        assert_eq!(key_code("F12"), Some(0x58));
        assert_eq!(key_code("a"), Some(0x1e));
        assert_eq!(key_code("M"), Some(0x32));
        assert_eq!(key_code("0"), Some(0x0b));
        assert_eq!(key_code("-"), Some(0x0c));
        assert_eq!(key_code("nope"), None);
        let ev = key_events("ctrl+alt+del").unwrap();
        let codes: Vec<(u16, bool)> = ev.iter().map(|e| match e { InputEvent::Key { code, down } => (*code, *down), _ => panic!() }).collect();
        assert_eq!(codes, [(0x1d, true), (0x38, true), (0xe053, true), (0xe053, false), (0x38, false), (0x1d, false)]);
        assert_eq!(key_events("win+r enter").unwrap().len(), 6);
        assert!(key_events("ctrl+bogus").is_err());
        assert!(key_events("  ").is_err());
    }

    #[test]
    fn text_types_enter_as_a_key() {
        let ev = text_events("a\r\n");
        assert!(matches!(ev[0], InputEvent::Unicode { ch: 'a', down: true }));
        assert!(matches!(ev[2], InputEvent::Key { code: 0x1c, down: true }));
        assert_eq!(ev.len(), 4);
    }

    #[test]
    fn fingerprints_look_like_mstsc() {
        assert_eq!(fingerprint(b"abc").len(), 32 * 3 - 1);
    }
}
