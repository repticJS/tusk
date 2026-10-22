//! Remote desktop (RDP) sessions shown in a Tusk tab. IronRDP does the
//! protocol; the changed parts of the screen go to the tab as raw RGBA.
//!
//! Messages to the tab on its channel:
//! - binary, first byte 1: screen update, u16 count, then per rectangle
//!   x, y, width, height (u16, little-endian) and its RGBA pixels
//! - binary, first byte 2: mouse pointer image, u16 width, height,
//!   hotspot x, hotspot y, then RGBA pixels
//! - JSON events (connected, resized, pointer, closed)

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
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc;

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
    Close,
    #[cfg(windows)]
    Clipboard(ironrdp_cliprdr::backend::ClipboardMessage),
}

#[derive(Default)]
pub struct RdpSessions {
    sessions: std::sync::Mutex<HashMap<String, mpsc::UnboundedSender<Input>>>,
    /// Passwords typed at a prompt, kept for this run of the app only.
    pub passwords: std::sync::Mutex<HashMap<String, String>>,
}

impl RdpSessions {
    fn send(&self, id: &str, input: Input) {
        if let Some(tx) = self.sessions.lock().unwrap().get(id) {
            let _ = tx.send(input);
        }
    }

    pub fn input(&self, id: &str, events: Vec<InputEvent>) {
        self.send(id, Input::Events(events));
    }

    pub fn resize(&self, id: &str, width: u16, height: u16, scale: u32) {
        self.send(id, Input::Resize { width, height, scale });
    }

    pub fn release_all(&self, id: &str) {
        self.send(id, Input::ReleaseAll);
    }

    pub fn close(&self, id: &str) {
        if let Some(tx) = self.sessions.lock().unwrap().remove(id) {
            let _ = tx.send(Input::Close);
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
    if let Some(old) = sessions.sessions.lock().unwrap().insert(req.session_id.clone(), tx.clone()) {
        let _ = old.send(Input::Close);
    }
    let id = req.session_id;
    let known_path = req.known_hosts;
    let scale = req.scale;
    tokio::spawn(async move {
        let mut rx = rx;
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
            let _ = events.send(json(&RdpEvent::Connected { width: result.desktop_size.width, height: result.desktop_size.height }));
            match run(framed, result, &events, &mut rx).await {
                Ok(Flow::Reconnect(s)) => size = s,
                Ok(Flow::Ended(reason)) => break reason,
                Err(e) => break Some(e),
            }
        };
        let _ = events.send(json(&RdpEvent::Closed { reason }));
        clipboard.stop(&app);
        // Forget the session unless a newer one took its place.
        let mut map = sessions.sessions.lock().unwrap();
        if map.get(&id).is_some_and(|t| t.same_channel(&tx)) {
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
    events: &Channel<InvokeResponseBody>,
    rx: &mut mpsc::UnboundedReceiver<Input>,
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
                    let _ = events.send(json(&RdpEvent::Pointer { kind: "default" }));
                }
                ActiveStageOutput::PointerHidden => {
                    let _ = events.send(json(&RdpEvent::Pointer { kind: "hidden" }));
                }
                ActiveStageOutput::PointerBitmap(p) => {
                    let _ = events.send(InvokeResponseBody::Raw(encode_pointer(&p)));
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
    fn fingerprints_look_like_mstsc() {
        assert_eq!(fingerprint(b"abc").len(), 32 * 3 - 1);
    }
}
