import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowListed, lineReader, proofFor } from "../src/cli/hookDaemon.js";

test("every environment variable src reads is one a daemon request carries", () => {
  // Otherwise a warm daemon would answer with the first spawner's value, not the hook's.
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const names = new Set<string>();
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts")) continue;
    // Direct reads and reads through an `env = process.env` alias (initiator, machine, ...);
    // variable names start upper-case, which skips unrelated objects named `env`.
    for (const m of readFileSync(join(root, file), "utf8").matchAll(/\benv(?:\.([A-Z]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])/g)) {
      names.add(m[1] ?? m[2]!);
    }
  }
  assert.ok(names.size > 0);
  // Upper-cased: a Windows-only spelling such as `env.Path` is the same variable there.
  assert.deepEqual([...names].filter((name) => !allowListed(name.toUpperCase())).sort(), []);
});

test("proofFor is a keyed, deterministic hex HMAC", () => {
  assert.match(proofFor("tok", "ab"), /^[0-9a-f]{64}$/);
  assert.equal(proofFor("tok", "ab"), proofFor("tok", "ab"));
  assert.notEqual(proofFor("tok", "ab"), proofFor("other", "ab"));
  assert.notEqual(proofFor("tok", "ab"), proofFor("tok", "ac"));
});

test("lineReader yields sequential frames and keeps leftovers", async () => {
  const stream = new PassThrough();
  const reader = lineReader(stream as unknown as Socket);
  stream.write('{"a":1}\n{"b":2}\n{"c"');
  assert.deepEqual(await reader.next(), { a: 1 });
  assert.deepEqual(await reader.next(), { b: 2 });
  const third = reader.next();
  stream.write(":3}\n");
  assert.deepEqual(await third, { c: 3 });
});

test("lineReader gives null on timeout, garbage and close", async () => {
  const stream = new PassThrough();
  const reader = lineReader(stream as unknown as Socket);
  assert.equal(await reader.next(20), null);
  stream.write("not json\n");
  assert.equal(await reader.next(), null);
  stream.end();
  assert.equal(await reader.next(), null);
});
