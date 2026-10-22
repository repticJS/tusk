import { FileText, MoreHorizontal, Play, Power, PowerOff, RefreshCw, RotateCw, Search, Square } from "lucide-react";
import { useState } from "react";
import type { Service, ServiceAction, ServicesInfo } from "../lib/api";
import { useApp } from "../store";
import { Spinner, useMenu } from "./ui";

const tone = (s: Service) =>
  s.active === "failed" ? "bg-danger" : s.sub === "running" ? "bg-ok" : s.active === "activating" || s.active === "deactivating" ? "bg-warn" : s.active === "active" ? "bg-accent/70" : "bg-faint/60";

/** Failed first, then running, then the rest. */
const rank = (s: Service) => (s.active === "failed" ? 0 : s.sub === "running" ? 1 : s.active === "active" ? 2 : 3);

/** systemd services of one target, inside its Discover card. */
export function ServicesSection({ target, services }: { target: string; services: ServicesInfo }) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const failed = services.units.filter((u) => u.active === "failed").length;
  const running = services.units.filter((u) => u.sub === "running").length;
  const q = filter.trim().toLowerCase();
  const shown = services.units
    .filter((u) => (q ? `${u.name} ${u.description}`.toLowerCase().includes(q) : showAll || u.active === "failed" || u.sub === "running"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col" data-services-section>
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <span className="text-[11px] font-semibold tracking-wide text-faint uppercase">Services</span>
        <span className="text-[11px] text-faint">
          · {running} running
          {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
        </span>
        <div className="flex-1" />
        <div className="flex h-6 w-48 items-center gap-1 rounded-md border border-border bg-bg px-1.5 focus-within:border-accent">
          <Search size={11} className="text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-faint"
            placeholder="Find a service"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Find a service"
          />
        </div>
        <label className="flex items-center gap-1 text-[11.5px] text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show stopped
        </label>
      </div>
      {services.privilege === "none" && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">
          Starting and stopping services needs root; Tusk will open a terminal so sudo can ask for your password.
        </div>
      )}
      <div className="max-h-[360px] overflow-auto pb-2">
        {shown.map((u) => (
          <ServiceRow key={u.name} target={target} u={u} />
        ))}
        {shown.length === 0 && <div className="px-4 py-2 text-[12.5px] text-faint">No matching services.</div>}
      </div>
    </div>
  );
}

function ServiceRow({ target, u }: { target: string; u: Service }) {
  const [busy, setBusy] = useState<ServiceAction | null>(null);
  const [menu, openMenu] = useMenu();
  const { serviceAction, serviceTerminal } = useApp.getState();
  const active = u.active === "active" || u.active === "activating";
  const act = async (a: ServiceAction) => {
    setBusy(a);
    await serviceAction(target, u.name, a);
    setBusy(null);
  };
  const button = (a: ServiceAction, title: string, icon: React.ReactNode) => (
    <button className="btn-ghost h-6 px-1.5" title={title} aria-label={`${title} ${u.name}`} disabled={busy !== null} onClick={() => void act(a)}>
      {busy === a ? <Spinner size={10} /> : icon}
    </button>
  );
  return (
    <div className="group flex items-center gap-2.5 px-4 py-1 hover:bg-hover/50" data-service={u.name} data-active={u.active}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone(u)}`} title={`${u.active} (${u.sub})`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]">
          <span className="font-medium">{u.name}</span>
          <span className="ml-2 text-[11.5px] text-muted">{u.description}</span>
        </div>
      </div>
      <span className={`shrink-0 text-[11px] ${u.active === "failed" ? "text-danger" : "text-muted"}`}>
        {u.active === "active" ? u.sub : u.active}
      </span>
      {u.enabled && (
        <span className={`shrink-0 rounded border border-border px-1 text-[10.5px] ${u.enabled === "enabled" ? "text-muted" : "text-faint"}`} data-enabled={u.enabled}>
          {u.enabled}
        </span>
      )}
      <button className="btn-ghost h-6 px-1.5" title="Logs (journal)" aria-label={`Logs ${u.name}`} onClick={() => void serviceTerminal(target, u.name, "logs")}>
        <FileText size={12} />
      </button>
      {active ? (
        <>
          {button("restart", "Restart", <RotateCw size={12} />)}
          {button("stop", "Stop", <Square size={11} />)}
        </>
      ) : (
        button("start", "Start", <Play size={12} />)
      )}
      <button
        className="btn-ghost h-6 px-1.5"
        aria-label={`More ${u.name}`}
        disabled={busy !== null}
        onClick={(e) =>
          openMenu(e, [
            { label: "Reload configuration", icon: <RefreshCw size={13} />, disabled: !active, onClick: () => void act("reload") },
            u.enabled === "enabled"
              ? { label: "Don't start at boot (disable)", icon: <PowerOff size={13} />, onClick: () => void act("disable") }
              : {
                  label: "Start at boot (enable)",
                  icon: <Power size={13} />,
                  disabled: u.enabled === "static" || u.enabled === "masked",
                  onClick: () => void act("enable"),
                },
          ])
        }
      >
        <MoreHorizontal size={13} />
      </button>
      {menu}
    </div>
  );
}
