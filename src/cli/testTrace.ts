import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
/** The slice of Commander's Command this reads. Structural, not `import type`: the hook
 *  bundle imports this module and test/bundle-cli.test.ts rejects any commander import. */
interface Command {
  parent: Command | null;
  options: readonly { long?: string; short?: string; negate?: boolean; attributeName(): string }[];
  name(): string;
  getOptionValueSource(key: string): string | undefined;
  getOptionValue(key: string): unknown;
}

/** Test-only execution evidence (#512): with HUNCH_TEST_TRACE naming a directory, record
 *  the "<command path> <flag>" keys this CLI run parsed from argv (keyed exactly like
 *  test/cli-options-surface.json; root options as the bare flag), written as soon as Commander settles them (preAction) for
 *  tooling/trace-gate.mjs. It lives in src because the published CLI is a bundle with
 *  Commander inlined, which no outside preload can patch. Inert without the variable. */
export function recordCliTrace(action: Command): void {
  const dir = process.env.HUNCH_TEST_TRACE;
  if (!dir) return;
  const keys = new Set<string>();
  for (let c: Command | null = action; c; c = c.parent) {
    const path: string[] = [];
    for (let p: Command | null = c; p?.parent; p = p.parent) path.unshift(p.name());
    for (const o of c.options) {
      const attr = o.attributeName();
      if (c.getOptionValueSource(attr) !== "cli") continue;
      // --x and --no-x share an attribute: the value says which one argv carried.
      const twins = c.options.filter((t) => t.attributeName() === attr);
      if (twins.length > 1 && Boolean(o.negate) !== (c.getOptionValue(attr) === false)) continue;
      const flag = o.long ?? o.short;
      if (flag) keys.add([...path, flag].join(" "));
    }
  }
  writeCliTrace([...keys]);
}

let written = 0;

/** Write one `{pid, cli, env: []}` record under HUNCH_TEST_TRACE. Synchronous and
 *  best-effort: a missing record is a gap the gate reports, never a pass. */
export function writeCliTrace(keys: string[]): void {
  const dir = process.env.HUNCH_TEST_TRACE;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `trace-cli-${process.pid}-${Date.now()}-${written++}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ pid: process.pid, cli: [...new Set(keys)].sort(), env: [] })}
`);
  } catch { /* best-effort */ }
}

/** The hook fast path (hookMain.ts / hookClient.ts) bypasses Commander; record the same
 *  key the full CLI would: `hook --provider` when argv passed one, nothing otherwise. */
export function traceFastHook(args: string[]): void {
  if (process.env.HUNCH_TEST_TRACE && args.length > 1) writeCliTrace(["hook --provider"]);
}
