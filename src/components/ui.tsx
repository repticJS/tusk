import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        className="flex max-h-full flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        style={{ width: props.width ?? 520 }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-[14px] font-semibold">{props.title}</div>
          <button className="btn-ghost h-7 w-7 justify-center px-0" onClick={props.onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
        {props.footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">{props.footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export type MenuEntry = MenuItem | "separator";

/** A floating menu at a screen position (context menus and dropdowns). */
export function FloatingMenu(props: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 6)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 6)),
    });
  }, [props.x, props.y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", props.onClose);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", props.onClose);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [props.onClose]);
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[2000] min-w-[190px] rounded-lg border border-border bg-panel p-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover disabled:opacity-40 ${
              item.danger ? "text-danger" : "text-text"
            }`}
            onClick={() => {
              props.onClose();
              item.onClick();
            }}
          >
            <span className="flex w-4 justify-center text-muted">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.hint && <span className="text-[11px] text-faint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Hook for showing a FloatingMenu: returns [element, open(eventOrPoint, items)]. */
export function useMenu(): [ReactNode, (at: { clientX: number; clientY: number }, items: MenuEntry[]) => void] {
  const [state, setState] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const el = state ? (
    <FloatingMenu x={state.x} y={state.y} items={state.items} onClose={() => setState(null)} />
  ) : null;
  return [el, (at, items) => setState({ x: at.clientX, y: at.clientY, items })];
}

/** Dropdown anchored under a button. */
export function DropdownButton(props: { label: ReactNode; className?: string; items: MenuEntry[]; title?: string }) {
  const [menu, open] = useMenu();
  return (
    <>
      <button
        title={props.title}
        className={props.className ?? "btn-ghost"}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          open({ clientX: r.left, clientY: r.bottom + 4 }, props.items);
        }}
      >
        {props.label}
      </button>
      {menu}
    </>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${props.className ?? ""}`}>
      <span className="text-[12px] font-medium text-muted">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[11.5px] text-faint">{props.hint}</span>}
    </label>
  );
}
