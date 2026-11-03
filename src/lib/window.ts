import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The remote desktop session this window shows, when it is a popped-out
 * remote desktop (its label is "rdp-<session id>"); null in the main window.
 */
export const popoutSession: string | null = (() => {
  try {
    const label = getCurrentWindow().label;
    return label.startsWith("rdp-") ? label.slice(4) : null;
  } catch {
    return null;
  }
})();
