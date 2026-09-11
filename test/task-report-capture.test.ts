import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { observeReportCapture } from "../src/core/taskReportCapture.js";
import { readTaskReport, startReportTask } from "../src/core/taskReport.js";
import { flushCapture } from "../src/integrations/sync.js";
import { mkConstraint } from "./helpers.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function repo(root: string) {
  mkdirSync(join(root, ".hunch"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.hunch/local.json\n.hunch/hunch.sqlite*\n");
  git(root, "add", ".gitignore"); git(root, "commit", "-qm", `fixture ${root}`);
}

test("save proofs follow actual shared home and never assign a different revision's publication", t => {
  const base = mkdtempSync(join(tmpdir(), "hunch-save-proof-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "code"), overlay = join(base, "memory"), remote = join(base, "remote.git");
  repo(root); repo(overlay);
  git(base, "init", "--bare", "-q", "-b", "main", remote);
  git(overlay, "remote", "add", "origin", remote);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: join(overlay, ".hunch"), mode: "shared" }));
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  const task = startReportTask(root, "Capture exact evidence");
  const first = store.putCapture("constraints", mkConstraint({ id: "con_exact_save", statement: "Retain this revision" }), false);
  assert.equal(store.captureHome(false), "private");
  const observed = observeReportCapture(root, task.task_id, "constraints", first, store.captureHome(false), false, store.privateDir!);
  assert.equal(flushCapture(store, hunchPaths(root).hunch, false, "capture first", undefined, observed.observe), "pushed");
  let report = readTaskReport(root, task.task_id);
  assert.equal(report.saves[0]!.home, "private");
  assert.equal(report.saves[0]!.durability, "pushed");
  assert.equal(report.saves[0]!.proofs.at(-1)!.commit, git(remote, "rev-parse", "refs/heads/main"));
  assert.equal(store.json.get("constraints", first.id), undefined, "shared capture must not create a public twin");

  const second = store.putCapture("constraints", { ...first, statement: "My revision before a concurrent writer" });
  const next = observeReportCapture(root, task.task_id, "constraints", second, "private", true, store.privateDir!);
  store.putCapture("constraints", { ...second, statement: "A later writer replaced this revision" });
  assert.equal(flushCapture(store, hunchPaths(root).hunch, false, "capture replaced", undefined, next.observe), "pushed");
  report = readTaskReport(root, task.task_id);
  assert.equal(report.saves[1]!.durability, "local", "aggregate push success cannot prove the replaced revision reached Git");
  assert.equal(report.saves[1]!.proofs.length, 0);
  git(overlay, "remote", "set-url", "origin", join(base, "unavailable.git"));
  const offline = store.putCapture("constraints", { ...second, statement: "Retained while remote is unavailable" });
  const pending = observeReportCapture(root, task.task_id, "constraints", offline, "private", true, store.privateDir!);
  assert.equal(flushCapture(store, hunchPaths(root).hunch, false, "offline capture", undefined, pending.observe), "committed");
  assert.equal(readTaskReport(root, task.task_id).saves[2]!.durability, "committed");
});

test("public capture proof is commit-only", t => {
  const base = mkdtempSync(join(tmpdir(), "hunch-save-local-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "code"); repo(root);
  const store = new HunchStore(hunchPaths(root)); t.after(() => store.close());
  const task = startReportTask(root, "Save public memory");
  const record = store.putCapture("constraints", mkConstraint({ id: "con_public_save" }));
  const observed = observeReportCapture(root, task.task_id, "constraints", record, "public", false, hunchPaths(root).hunch);
  assert.equal(flushCapture(store, hunchPaths(root).hunch, false, "public capture", undefined, observed.observe), "committed");
  assert.equal(readTaskReport(root, task.task_id).saves[0]!.durability, "committed");
  assert.equal(readTaskReport(root, task.task_id).saves[0]!.proofs[0]!.commit, git(root, "rev-parse", "HEAD"));
});
