// Test-only execution trace (#512). tooling/run-tests.mjs preloads this module into every
// Node process of a test run (NODE_OPTIONS --import) when HUNCH_TEST_TRACE names a
// directory. It records which environment variable names each process read directly with
// a non-empty value, one JSON line per process at exit. CLI flags are recorded by the CLI
// itself (src/cli/testTrace.ts): the published CLI is a bundle with Commander inlined,
// which a preload cannot patch. tooling/trace-gate.mjs merges both kinds of record.
// Without HUNCH_TEST_TRACE this module is never loaded.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.HUNCH_TEST_TRACE;
if (dir && !globalThis.__hunchTestTrace) {
  globalThis.__hunchTestTrace = true;
  const env = new Set();

  // Spread, Object.entries, JSON.stringify and child_process env copies first enumerate the
  // keys ([[OwnPropertyKeys]]) and then [[Get]] them; a direct `process.env.X` is a lone
  // [[Get]]. A Get of a key still pending from the last enumeration is part of such a copy
  // and is not a read (each key once; any order, since spawn on Windows sorts the keys
  // case-insensitively first). Any other Get ends the copy and is recorded. Copies are
  // synchronous, so the pending set expires at the next microtask: an Object.keys with no
  // Gets cannot swallow a later direct read.
  let pending = null;
  const reset = () => { pending = null; };
  const real = process.env;
  const note = (key) => { if (typeof key === "string" && real[key]) env.add(key); };
  process.env = new Proxy(real, {
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      const set = pending = new Set(keys);
      queueMicrotask(() => { if (pending === set) reset(); });
      return keys;
    },
    get(target, key) {
      if (!pending?.delete(key)) { reset(); note(key); }
      return Reflect.get(target, key);
    },
    has(target, key) { reset(); note(key); return Reflect.has(target, key); },
    // process.env coerces and validates writes itself; forward them to it unchanged
    // (without these traps an assignment to an existing variable throws).
    set(target, key, value) { reset(); target[key] = value; return true; },
    defineProperty(target, key, descriptor) { reset(); return Reflect.defineProperty(target, key, descriptor); },
    deleteProperty(target, key) { reset(); return delete target[key]; },
  });

  process.on("exit", () => {
    try {
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ pid: process.pid, argv1: process.argv[1] ?? null, cli: [], env: [...env].sort() });
      appendFileSync(join(dir, `trace-env-${process.pid}-${Date.now()}.jsonl`), `${line}\n`);
    } catch { /* evidence is best-effort; a missing record shows up as a gap, never a pass */ }
  });
}
