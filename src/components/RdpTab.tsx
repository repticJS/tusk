import { ChevronDown, Keyboard, Maximize, Minimize, MonitorX, Pencil, RotateCw, ScreenShare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DbError, rdpApi, type RdpEvent, type RdpInput } from "../lib/api";
import { useApp, type RdpTab as RdpTabModel } from "../store";
import { DropdownButton, Spinner } from "./ui";

/** KeyboardEvent.code → set-1 scancode (0xE0xx for extended keys). */
const SCANCODES: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
  KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEqual: 0x59,
  F13: 0x64, F14: 0x65, F15: 0x66, F16: 0x67, F17: 0x68, F18: 0x69, F19: 0x6a, F20: 0x6b, F21: 0x6c, F22: 0x6d,
  F23: 0x6e, F24: 0x76, KanaMode: 0x70, IntlRo: 0x73, Convert: 0x79, NonConvert: 0x7b, IntlYen: 0x7d,
  NumpadComma: 0x7e,
  MediaTrackPrevious: 0xe010, MediaTrackNext: 0xe019, NumpadEnter: 0xe01c, ControlRight: 0xe01d,
  AudioVolumeMute: 0xe020, LaunchApp2: 0xe021, MediaPlayPause: 0xe022, MediaStop: 0xe024,
  AudioVolumeDown: 0xe02e, AudioVolumeUp: 0xe030, BrowserHome: 0xe032, NumpadDivide: 0xe035,
  PrintScreen: 0xe037, AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053,
  MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d, BrowserSearch: 0xe065, BrowserFavorites: 0xe066,
  BrowserRefresh: 0xe067, BrowserStop: 0xe068, BrowserForward: 0xe069, BrowserBack: 0xe06a, LaunchApp1: 0xe06b,
  LaunchMail: 0xe06c, MediaSelect: 0xe06d,
};

const MODIFIERS = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

/** Key combinations that can't be typed into the tab (the PC keeps them). */
const SPECIAL_KEYS: { label: string; keys: number[] }[] = [
  { label: "Ctrl+Alt+Del", keys: [0x1d, 0x38, 0xe053] },
  { label: "Windows key (Start)", keys: [0xe05b] },
  { label: "Alt+Tab", keys: [0x38, 0x0f] },
  { label: "Ctrl+Shift+Esc (Task Manager)", keys: [0x1d, 0x2a, 0x01] },
  { label: "Windows+L (lock)", keys: [0xe05b, 0x26] },
  { label: "Print Screen", keys: [0xe037] },
];

type Phase =
  | { phase: "connecting" }
  | { phase: "connected" }
  | { phase: "closed"; message?: string | null }
  | { phase: "error"; message: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A cursor image as CSS. */
function cursorCss(view: DataView, buf: ArrayBuffer): string {
  const w = view.getUint16(1, true);
  const h = view.getUint16(3, true);
  const hx = view.getUint16(5, true);
  const hy = view.getUint16(7, true);
  if (!w || !h) return "none";
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf, 9, w * h * 4), w, h), 0, 0);
  return `url(${c.toDataURL()}) ${Math.min(hx, w - 1)} ${Math.min(hy, h - 1)}, default`;
}

export function RdpTab({ tab, active }: { tab: RdpTabModel; active: boolean }) {
  const conn = useApp((s) => s.rdpConnections.find((r) => r.id === tab.connId));
  const fullScreen = useApp((s) => s.fullScreenTab === tab.id);
  const [state, setState] = useState<Phase>({ phase: "connecting" });
  const [desk, setDesk] = useState<{ width: number; height: number } | null>(null);
  const [cursor, setCursor] = useState("default");
  const [barVisible, setBarVisible] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef(desk);
  deskRef.current = desk;
  const connected = state.phase === "connected";
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const fixed = !!conn && conn.size !== "fit";
  const scroll = fixed && conn?.scale === "none";

  /** What the remote desktop should be: the tab's size in device pixels. */
  const measure = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      width: Math.max(200, Math.round((r?.width || 1024) * dpr)),
      height: Math.max(200, Math.round((r?.height || 768) * dpr)),
      scale: Math.round(dpr * 100),
    };
  }, []);

  const onData = useCallback((buf: ArrayBuffer) => {
    const view = new DataView(buf);
    const kind = view.getUint8(0);
    if (kind === 2) {
      setCursor(cursorCss(view, buf));
      return;
    }
    const ctx = canvasRef.current?.getContext("2d");
    if (kind !== 1 || !ctx) return;
    const count = view.getUint16(1, true);
    let off = 3;
    for (let i = 0; i < count; i++) {
      const x = view.getUint16(off, true);
      const y = view.getUint16(off + 2, true);
      const w = view.getUint16(off + 4, true);
      const h = view.getUint16(off + 6, true);
      off += 8;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, off, w * h * 4), w, h), x, y);
      off += w * h * 4;
    }
  }, []);

  const onEvent = useCallback((e: RdpEvent) => {
    if (e.type === "connected" || e.type === "resized") {
      // Size the canvas now, before the next screen update arrives.
      const c = canvasRef.current;
      if (c && (c.width !== e.width || c.height !== e.height)) {
        c.width = e.width;
        c.height = e.height;
      }
      setDesk({ width: e.width, height: e.height });
      if (e.type === "connected") setState({ phase: "connected" });
    } else if (e.type === "pointer") {
      setCursor(e.kind === "hidden" ? "none" : "default");
    } else if (e.type === "closed") {
      setState({ phase: "closed", message: e.reason });
      setCursor("default");
    }
  }, []);

  const connect = useCallback(
    async (accept: string | null = null) => {
      const s = useApp.getState();
      setState({ phase: "connecting" });
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rdpApi.open(tab.id, tab.connId, measure(), accept, onData, onEvent);
          return;
        } catch (e) {
          const info = e instanceof DbError ? e.info : null;
          const kind = info?.kind;
          if ((kind === "RDP_CERT_UNKNOWN" || kind === "RDP_CERT_CHANGED") && info) {
            const ok = await s.requestHostKey({
              hostId: tab.connId,
              message: info.message,
              key: info.detail ?? "",
              changed: kind === "RDP_CERT_CHANGED",
              certificate: true,
            });
            if (!ok) return setState({ phase: "error", message: "The computer's certificate wasn't trusted." });
            accept = info.hint ?? null;
            continue;
          }
          if (kind === "RDP_PASSWORD_REQUIRED" || kind === "RDP_AUTH_FAILED") {
            const r = await s.requestSshSecret({
              hostId: tab.connId,
              what: "password",
              message: kind === "RDP_AUTH_FAILED" ? info?.message : undefined,
            });
            if (!r) return setState({ phase: "error", message: info?.message ?? "A password is needed" });
            await rdpApi.setPassword(tab.connId, r.secret, r.save);
            continue;
          }
          return setState({ phase: "error", message: errText(e) });
        }
      }
    },
    [tab.id, tab.connId, measure, onData, onEvent],
  );

  // Connect once the tab has a size; disconnect when it closes.
  useEffect(() => {
    const t = setTimeout(() => void connect(), 30);
    if (conn?.fullScreen) useApp.getState().setFullScreenTab(tab.id);
    return () => {
      clearTimeout(t);
      void rdpApi.close(tab.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Fit the tab": follow the tab's size (after the user stops resizing).
  useEffect(() => {
    if (fixed || !boxRef.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!connectedRef.current || !boxRef.current?.offsetWidth) return;
        const m = measure();
        const d = deskRef.current;
        if (d && Math.abs(d.width - m.width) < 4 && Math.abs(d.height - m.height) < 4) return;
        void rdpApi.resize(tab.id, m.width, m.height, m.scale);
      }, 400);
    });
    ro.observe(boxRef.current);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [fixed, measure, tab.id]);

  // Keys and buttons held while the tab loses focus would stay pressed.
  useEffect(() => {
    if (!active) void rdpApi.release(tab.id);
  }, [active, tab.id]);

  useEffect(() => {
    if (fullScreen) setTimeout(() => canvasRef.current?.focus(), 80);
  }, [fullScreen]);

  // ---- input ----

  const moves = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);

  const toDesk = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * c.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * c.height);
    return { x: Math.max(0, Math.min(c.width - 1, x)), y: Math.max(0, Math.min(c.height - 1, y)) };
  };

  const send = (events: RdpInput[]) => {
    if (connectedRef.current && events.length) void rdpApi.input(tab.id, events);
  };

  /** Sends the latest pointer position (moves are batched per frame). */
  const flushMove = (): RdpInput[] => {
    const m = moves.current;
    moves.current = null;
    return m ? [{ t: "m", x: m.x, y: m.y }] : [];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!connected) return;
    moves.current = toDesk(e);
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        send(flushMove());
      });
    }
  };

  const onPointerButton = (e: React.PointerEvent, down: boolean) => {
    if (!connected) return;
    e.preventDefault();
    if (down) {
      canvasRef.current?.focus();
      canvasRef.current?.setPointerCapture(e.pointerId);
    }
    moves.current = toDesk(e);
    send([...flushMove(), { t: "b", button: e.button, down }]);
  };

  // Wheel events must not scroll the page, which needs a non-passive listener.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!connectedRef.current) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1.2;
      const events: RdpInput[] = [];
      if (e.deltaY) events.push({ t: "w", delta: Math.round(-e.deltaY * unit), horizontal: false });
      if (e.deltaX) events.push({ t: "w", delta: Math.round(e.deltaX * unit), horizontal: true });
      moves.current = toDesk(e);
      send([...flushMove(), ...events.filter((x) => x.t === "w" && x.delta !== 0)]);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: React.KeyboardEvent, down: boolean) => {
    if (!connected) return;
    const k = e.key.toLowerCase();
    // Ctrl+Shift+W/T/P/K stay with Tusk (like in terminals).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["w", "t", "p", "k"].includes(k)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && MODIFIERS.has(e.code)) return;
    const code = SCANCODES[e.code];
    if (code !== undefined) send([{ t: "k", code, down }]);
    else if (e.key.length === 1) send([{ t: "u", ch: e.key, down }]);
  };

  const sendKeys = (keys: number[]) => {
    send([...keys.map((code): RdpInput => ({ t: "k", code, down: true })), ...[...keys].reverse().map((code): RdpInput => ({ t: "k", code, down: false }))]);
    canvasRef.current?.focus();
  };

  const toggleFullScreen = () => useApp.getState().setFullScreenTab(fullScreen ? null : tab.id);

  // ---- rendering ----

  const keysMenu = SPECIAL_KEYS.map((s) => ({ label: s.label, onClick: () => sendKeys(s.keys) }));
  const canvasStyle: React.CSSProperties = scroll
    ? { width: (desk?.width ?? 0) / (window.devicePixelRatio || 1), height: (desk?.height ?? 0) / (window.devicePixelRatio || 1) }
    : { width: "100%", height: "100%", objectFit: "contain" };

  const toolbar = (
    <>
      <ScreenShare size={14} style={{ color: conn?.color ?? undefined }} className="shrink-0" />
      <span className="truncate font-medium">{conn?.name ?? tab.title}</span>
      <span className="truncate text-faint">
        {conn ? `${conn.domain ? `${conn.domain}\\` : ""}${conn.user ? `${conn.user}@` : ""}${conn.host}` : ""}
        {desk && connected ? ` · ${desk.width}×${desk.height}` : ""}
      </span>
      <div className="flex-1" />
      <DropdownButton
        className="btn-ghost h-7 px-2"
        title="Send keys the PC keeps for itself"
        label={
          <>
            <Keyboard size={13} /> Send keys <ChevronDown size={11} />
          </>
        }
        items={keysMenu}
      />
      <button className="btn-ghost h-7 px-2" onClick={toggleFullScreen} title={fullScreen ? "Exit full screen" : "Full screen"} aria-label="Toggle full screen">
        {fullScreen ? <Minimize size={13} /> : <Maximize size={13} />} {fullScreen ? "Exit full screen" : "Full screen"}
      </button>
      {connected ? (
        <button className="btn-ghost h-7 px-2" onClick={() => void rdpApi.close(tab.id)} title="Disconnect">
          <MonitorX size={13} /> Disconnect
        </button>
      ) : (
        <button className="btn-ghost h-7 px-2" onClick={() => void connect()} disabled={state.phase === "connecting"}>
          <RotateCw size={13} /> Reconnect
        </button>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col bg-bg" data-rdp-tab={tab.title} data-rdp-state={state.phase}>
      {!fullScreen && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12.5px]">{toolbar}</div>
      )}
      <div ref={boxRef} className={`relative min-h-0 flex-1 bg-black ${scroll ? "overflow-auto" : "overflow-hidden"}`}>
        {fullScreen && (
          // A bar that slides down when the pointer reaches the top edge.
          <div
            className="absolute inset-x-0 top-0 z-10 flex justify-center"
            onMouseEnter={() => setBarVisible(true)}
            onMouseLeave={() => setBarVisible(false)}
            style={{ height: barVisible ? undefined : 6 }}
          >
            {barVisible && (
              <div className="mt-0 flex w-[min(720px,90%)] items-center gap-2 rounded-b-lg border border-t-0 border-border bg-panel px-3 py-1.5 text-[12.5px] shadow-lg">
                {toolbar}
              </div>
            )}
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={1}
          height={1}
          tabIndex={0}
          data-rdp-surface
          className="block outline-none"
          style={{ ...canvasStyle, cursor: connected ? cursor : "default", visibility: desk ? "visible" : "hidden" }}
          onPointerMove={onPointerMove}
          onPointerDown={(e) => onPointerButton(e, true)}
          onPointerUp={(e) => onPointerButton(e, false)}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onBlur={() => void rdpApi.release(tab.id)}
          aria-label={`Remote desktop ${tab.title}`}
        />
        {state.phase !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/85 p-6">
            {state.phase === "connecting" ? (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <Spinner size={13} /> Connecting to {conn?.name ?? "the computer"}…
              </div>
            ) : (
              <div className="flex max-w-[460px] flex-col items-center gap-3 text-center" data-rdp-message>
                <div className="text-[14px] font-medium">{state.phase === "error" ? "Couldn't connect" : "Disconnected"}</div>
                {state.message && (
                  <div className={`text-[12.5px] ${state.phase === "error" ? "text-danger" : "text-muted"}`}>{state.message}</div>
                )}
                <div className="flex gap-2">
                  <button className="btn-primary" onClick={() => void connect()}>
                    <RotateCw size={12} /> Reconnect
                  </button>
                  {conn && (
                    <button className="btn-outline" onClick={() => useApp.getState().openRdpDialog(conn)}>
                      <Pencil size={12} /> Edit connection
                    </button>
                  )}
                  {fullScreen && (
                    <button className="btn-outline" onClick={toggleFullScreen}>
                      <Minimize size={12} /> Exit full screen
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
