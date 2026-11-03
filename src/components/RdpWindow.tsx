import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { rdpApi, type ClaudeActivity } from "../lib/api";
import { useApp } from "../store";
import { RdpTab } from "./RdpTab";
import { HostKeyPrompt, SshSecretPrompt } from "./SshDialogs";
import { Spinner } from "./ui";

/** A popped-out remote desktop: one session, in a window of its own. */
export function RdpWindow({ sessionId }: { sessionId: string }) {
  // undefined while loading, null once the session has ended.
  const [connId, setConnId] = useState<string | null | undefined>(undefined);
  const conn = useApp((s) => s.rdpConnections.find((r) => r.id === connId));

  useEffect(() => {
    void rdpApi.list().then((rdpConnections) => useApp.setState({ rdpConnections }));
    void rdpApi.sessionConn(sessionId).then(setConnId, () => setConnId(null));
    // Claude's activity, for the "Claude is using this desktop" note.
    void useApp.getState().loadClaude();
    const unChanged = listen("claude-changed", () => void useApp.getState().loadClaude());
    const unActivity = listen<ClaudeActivity>("claude-activity", (e) => useApp.getState().claudeActivity(e.payload));
    // Browser shortcuts (reload, find, print…) would only get in the way here.
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && ["r", "f", "g", "u", "j", "p"].includes(key))) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void unChanged.then((f) => f());
      void unActivity.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, [sessionId]);

  useEffect(() => {
    if (conn) document.title = `${conn.name} · Tusk`;
  }, [conn]);

  if (connId === undefined) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 bg-bg text-[13px] text-muted">
        <Spinner size={13} /> Opening…
      </div>
    );
  }
  if (connId === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-bg text-[13px] text-muted">
        This remote desktop session has ended.
        <button className="btn-outline" onClick={() => void getCurrentWindow().close()}>
          Close window
        </button>
      </div>
    );
  }
  return (
    <div className="h-screen bg-bg">
      <RdpTab tab={{ id: sessionId, kind: "rdp", connId, title: conn?.name ?? "Remote desktop" }} active windowed />
      <HostKeyPrompt />
      <SshSecretPrompt />
    </div>
  );
}
