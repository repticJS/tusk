// Multi-exec: input typed in one terminal is also sent to the others the
// user picked. Each open terminal registers how to send it input.
import { useApp } from "../store";

const writers = new Map<string, (data: string) => void>();

export function registerTerminal(id: string, send: (data: string) => void) {
  writers.set(id, send);
  return () => {
    if (writers.get(id) === send) writers.delete(id);
  };
}

/** Sends input typed in terminal `from` to the other multi-exec targets. */
export function broadcast(from: string, data: string) {
  const { on, targets } = useApp.getState().multiExec;
  if (!on || !targets.includes(from)) return;
  for (const id of targets) if (id !== from) writers.get(id)?.(data);
}
