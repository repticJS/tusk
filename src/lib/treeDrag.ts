// Pointer-based drag and drop for the sidebar tree. HTML5 drag and drop is
// unavailable on Windows while Tauri's native file drop (used for SFTP
// uploads) is enabled, so rows track the pointer themselves.
//
// Drop targets are elements with a data-drop attribute: a folder id, or ""
// for the top level. The innermost one under the pointer wins.
import { create } from "zustand";
import type { ItemKind } from "./api";

export interface DragItem {
  kind: ItemKind;
  id: string;
  label: string;
}

interface DragState {
  item: DragItem | null;
  x: number;
  y: number;
  /** Folder id under the pointer, "" for the top level, null for none. */
  over: string | null;
}

export const useTreeDrag = create<DragState>(() => ({ item: null, x: 0, y: 0, over: null }));

let suppressClickUntil = 0;

/** True right after a drag ends, so the release doesn't also count as a click. */
export const clickSuppressed = () => Date.now() < suppressClickUntil;

function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop]");
  return el ? el.getAttribute("data-drop") : null;
}

export function startTreeDrag(
  e: React.PointerEvent,
  item: DragItem,
  onDrop: (item: DragItem, folderId: string | null) => void,
) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    useTreeDrag.setState({ item: null, over: null });
  };
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    dragging = true;
    useTreeDrag.setState({ item, x: ev.clientX, y: ev.clientY, over: dropTargetAt(ev.clientX, ev.clientY) });
  };
  const up = (ev: PointerEvent) => {
    const target = dragging ? dropTargetAt(ev.clientX, ev.clientY) : null;
    if (dragging) suppressClickUntil = Date.now() + 300;
    finish();
    if (target !== null) onDrop(item, target === "" ? null : target);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && dragging) {
      ev.stopPropagation();
      suppressClickUntil = Date.now() + 300;
      finish();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
