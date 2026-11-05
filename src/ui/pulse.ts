/**
 * `hunch ui` pulse: what changed in memory since the page last asked. The server keeps a
 * snapshot of every memory item and a short ring of changes with a rising seq; the first read
 * only sets the baseline. Read-only and in-memory: nothing is stored, nothing is inferred.
 */
import type { MemoryItem, MemoryKind } from "./model.js";

export interface PulseChange { seq: number; id: string; title: string; kind: MemoryKind; change: "added" | "changed" | "removed"; components: string[] }
export interface Pulse { seq: number; attention: number; changes: PulseChange[] }

const RING = 100;
const signature = (m: MemoryItem): string => JSON.stringify([m.title, m.summary, m.status, m.active, m.signed, m.delivery, m.feature, m.components.map((c) => c.id), m.files]);

export function createPulse(): { read(items: readonly MemoryItem[], since: number, attention: number): Pulse } {
  let known: Map<string, { sig: string; title: string; kind: MemoryKind; components: string[] }> | null = null;
  let seq = 0;
  const ring: PulseChange[] = [];
  const push = (c: Omit<PulseChange, "seq">): void => { ring.push({ seq: ++seq, ...c }); if (ring.length > RING) ring.shift(); };
  return {
    read(items, since, attention) {
      const now = new Map(items.map((m) => [m.id, { sig: signature(m), title: m.title, kind: m.kind, components: m.components.map((c) => c.id) }]));
      if (known) {
        for (const [id, m] of now) {
          const before = known.get(id);
          if (!before) push({ id, title: m.title, kind: m.kind, change: "added", components: m.components });
          else if (before.sig !== m.sig) push({ id, title: m.title, kind: m.kind, change: "changed", components: [...new Set([...before.components, ...m.components])] });
        }
        for (const [id, m] of known) if (!now.has(id)) push({ id, title: m.title, kind: m.kind, change: "removed", components: m.components });
      }
      known = now;
      return { seq, attention, changes: ring.filter((c) => c.seq > since) };
    },
  };
}
