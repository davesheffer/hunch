import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allowListed, anchorNodeOptions, lineReader, proofFor } from "../src/cli/hookDaemon.js";

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

test("lineReader counts UTF-8 bytes, not UTF-16 units, against its limit", async () => {
  // 6 characters, 12 bytes: past a 10-byte limit although its string length is not.
  const over = new PassThrough();
  const reader = lineReader(over as unknown as Socket, 10);
  over.write(`"${"é".repeat(5)}"\n`);
  assert.equal(await reader.next(), null);
  assert.ok((over as unknown as { destroyed: boolean }).destroyed);
  // The limit can be raised between messages (the daemon does, once a hello checks out).
  const under = new PassThrough();
  const raised = lineReader(under as unknown as Socket, 10);
  under.write('"a"\n');
  assert.equal(await raised.next(), "a");
  raised.maxBytes = 64;
  under.write(`"${"é".repeat(5)}"\n`);
  assert.equal(await raised.next(), "é".repeat(5));
});

test("lineReader decodes a multi-byte character split across chunks", async () => {
  const stream = new PassThrough();
  const reader = lineReader(stream as unknown as Socket);
  const bytes = Buffer.from('{"s":"€"}\n');
  const pending = reader.next<{ s: string }>();
  // "€" is 3 bytes; cut inside it.
  for (const piece of [bytes.subarray(0, 7), bytes.subarray(7, 8), bytes.subarray(8)]) stream.write(piece);
  assert.deepEqual(await pending, { s: "€" });
});

test("lineReader takes linear time on a large message arriving in socket-sized chunks", async () => {
  // Rescanning the whole buffer on every chunk made 32 MB take 4-12 s; one pass takes ~40 ms.
  const stream = new PassThrough();
  const reader = lineReader(stream as unknown as Socket);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const started = Date.now();
  const pending = reader.next<string>();
  stream.write('"');
  for (let i = 0; i < 32 * 16; i++) stream.write(chunk);
  stream.write('"\n');
  assert.equal((await pending)?.length, 32 * 1024 * 1024);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
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

test("anchorNodeOptions pins relative preloads to the hook's cwd and leaves everything else alone", () => {
  const cwd = resolve("/work/repo");
  for (const same of ["", "--max-old-space-size=4096", "--require pkg --import @scope/x", '--title "a b"']) {
    assert.equal(anchorNodeOptions(same, cwd), same);
  }
  const q = (t: string) => (/[\s"\\]/.test(t) ? `"${t.replace(/[\\"]/g, "\\$&")}"` : t);
  assert.equal(
    anchorNodeOptions('--require ./a.cjs -r ../b.cjs --import=./c.mjs --loader "./d e.mjs" --inspect', cwd),
    [
      "--require", q(resolve(cwd, "a.cjs")), "-r", q(resolve(cwd, "../b.cjs")),
      q(`--import=${pathToFileURL(resolve(cwd, "c.mjs")).href}`),
      "--loader", q(pathToFileURL(resolve(cwd, "d e.mjs")).href), "--inspect",
    ].join(" "),
  );
});
