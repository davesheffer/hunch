#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv.indexOf("--output");
const outputFile = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
if (outputArg >= 0 && !outputFile) throw new Error("--output requires a file path");

/** Quote one arg for cmd.exe (same contract as the extension's winQuote). */
function winQuote(a) {
  return /[\s"&|<>^()%!,;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function run(command, args, options = {}) {
  // Windows: npm is a .cmd shim; Node >=18.20 refuses shell-less shim spawns
  // (CVE-2024-27980) — route through cmd.exe with args quoted ourselves
  // (dec_812d887be0). Everything else keeps the shell-free argv form.
  if (process.platform === "win32" && command === "npm") {
    return execFileSync("cmd.exe", ["/d", "/s", "/c", ["npm", ...args].map(winQuote).join(" ")], { encoding: "utf8", windowsVerbatimArguments: true, ...options }).trim();
  }
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function git(root, args, env) {
  return run("git", args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

function write(root, file, value) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function allText(root) {
  if (!existsSync(root)) return "";
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, name.name);
      if (name.isDirectory()) visit(file);
      else if (name.isFile()) files.push(file);
    }
  };
  visit(root);
  return files.sort().map((file) => readFileSync(file, "utf8")).join("\n");
}

function corpusDecision(id, title, conformance, commit, privateRecord = false) {
  return {
    id,
    title,
    topic: `clean-rehearsal.${id}`,
    status: "accepted",
    context: "Curated clean-install Constitution fixture.",
    decision: title,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/app.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit,
    valid_from: "2026-07-10T10:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [conformance],
    provenance: {
      source: "human_confirmed",
      confidence: 1,
      evidence: [privateRecord ? "PRIVATE_REHEARSAL_SENTINEL" : "clean-rehearsal"],
    },
    date: "2026-07-10T10:00:00.000Z",
  };
}

const temp = mkdtempSync(join(tmpdir(), "hunch-clean-rehearsal-"));
try {
  const packDir = join(temp, "pack");
  const installDir = join(temp, "install");
  const repo = join(temp, "repository");
  const cleanHome = join(temp, "home");
  const privateHome = join(temp, "private-overlay", ".hunch");
  for (const dir of [packDir, installDir, repo, cleanHome, privateHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: projectRoot }))[0];
  const tarball = join(packDir, pack.filename);
  const npmConfig = join(cleanHome, "npmrc");
  writeFileSync(npmConfig, "fund=false\naudit=false\n");
  run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--package-lock=false", tarball], {
    cwd: installDir,
    env: { ...process.env, HOME: cleanHome, NPM_CONFIG_USERCONFIG: npmConfig },
  });

  const installed = join(installDir, "node_modules", "@davesheffer", "hunch", "dist");
  const [{ HunchStore }, { hunchPaths }, { indexRepo }, { ConstitutionService }] = await Promise.all([
    import(pathToFileURL(join(installed, "store/hunchStore.js"))),
    import(pathToFileURL(join(installed, "core/paths.js"))),
    import(pathToFileURL(join(installed, "extractors/indexer.js"))),
    import(pathToFileURL(join(installed, "constitution/service.js"))),
  ]);

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "rehearsal@example.invalid"]);
  git(repo, ["config", "user.name", "Hunch Rehearsal"]);
  const commitEnv = {
    GIT_AUTHOR_DATE: "2026-07-10T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-07-10T10:00:00Z",
  };
  write(repo, "src/db.ts", "export function dbQuery(value){ return value; }\n");
  write(repo, "src/service.ts", 'import { dbQuery } from "./db.js";\nexport function serviceQuery(value){ return dbQuery(value); }\n');
  write(repo, "src/auth.ts", "export function verifySession(value){ return value; }\n");
  write(repo, "src/app.ts", [
    'import { dbQuery } from "./db.js";',
    "export function charge(value){ return value; }",
    "export function controller(value){ return dbQuery(value); }",
    "export function route(value){ return dbQuery(value); }",
    "",
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "fixture: known bad architecture"], commitEnv);
  const knownBad = git(repo, ["rev-parse", "HEAD"]);

  write(repo, "src/app.ts", [
    'import { verifySession } from "./auth.js";',
    'import { serviceQuery } from "./service.js";',
    "export function requiredEntry(value){ return value; }",
    "export function charge(value){ return verifySession(value); }",
    "export function controller(value){ return serviceQuery(value); }",
    "export function route(value){ return serviceQuery(value); }",
    "",
  ].join("\n"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "fixture: known good architecture"], {
    ...commitEnv,
    GIT_AUTHOR_DATE: "2026-07-10T10:01:00Z",
    GIT_COMMITTER_DATE: "2026-07-10T10:01:00Z",
  });
  const knownGood = git(repo, ["rev-parse", "HEAD"]);

  const hookSentinel = join(temp, "hook-executed");
  write(repo, ".git/hooks/post-checkout", `#!/bin/sh\ntouch '${hookSentinel}'\n`);
  chmodSync(join(repo, ".git/hooks/post-checkout"), 0o755);
  write(repo, ".hunch/local.json", JSON.stringify({ privateDir: privateHome, mode: "private", autoCommit: false }));

  const previousEnv = {
    HOME: process.env.HOME,
    HUNCH_PRIVATE_DIR: process.env.HUNCH_PRIVATE_DIR,
    HUNCH_SYNTH_PROVIDER: process.env.HUNCH_SYNTH_PROVIDER,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    no_proxy: process.env.no_proxy,
  };
  Object.assign(process.env, {
    HOME: cleanHome,
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "",
  });

  const store = new HunchStore(hunchPaths(repo));
  try {
    store.json.ensureDirs();
    indexRepo(store, repo, { churn: false });
    const publicCases = [
      ["dec_clean_exists", "requiredEntry must exist", { assert: "exists", subject: "requiredEntry", transitive: false }, undefined],
      ["dec_clean_reaches", "charge must verify the session", { assert: "calls", subject: "charge", object: "verifySession", transitive: false }, undefined],
      ["dec_clean_not_reaches", "controller must not call the database directly", { assert: "not-calls", subject: "controller", object: "dbQuery", transitive: false }, undefined],
      ["dec_clean_must_pass", "route must reach the database through the service", { assert: "not-calls", subject: "route", object: "dbQuery", transitive: false }, "serviceQuery"],
    ];
    for (const [id, title, conformance] of publicCases) store.json.put("decisions", corpusDecision(id, title, conformance, knownGood));
    store.putPrivate("decisions", corpusDecision(
      "dec_clean_private_exists",
      "private required entry must exist",
      { assert: "exists", subject: "requiredEntry", transitive: false },
      knownGood,
      true,
    ));
    store.reindex();
    const service = new ConstitutionService(store, repo);
    const cases = [];
    for (const [index, [id, _title, _conformance, through]] of publicCases.entries()) {
      const policy = service.compile(id, { ...(through ? { through } : {}), now: `2026-07-10T10:0${index + 2}:00.000Z` });
      cases.push({ policy, dataClass: "public" });
    }
    const privatePolicy = service.compile("dec_clean_private_exists", { now: "2026-07-10T10:06:00.000Z" });
    cases.push({ policy: privatePolicy, dataClass: "private" });

    const installedCli = join(installed, "cli/index.js");
    const cliCorpusInput = join(temp, "cli-corpus.json");
    writeFileSync(cliCorpusInput, JSON.stringify({
      known_bad: [{ ref: knownBad.slice(0, 12), label: "exists known bad" }],
      known_good: [{ ref: "HEAD", label: "exists known good" }],
    }));
    run(process.execPath, [installedCli, "policy", "corpus", cases[0].policy.id, "--import", cliCorpusInput], {
      cwd: repo,
      env: process.env,
    });

    const publicReceipts = [];
    let primaryCaught = 0;
    let controlsPassed = 0;
    let knownBadCaught = 0;
    let knownGoodPassed = 0;
    for (const [index, entry] of cases.entries()) {
      const labelPrefix = entry.dataClass === "private" ? "PRIVATE_REHEARSAL_SENTINEL" : entry.policy.assertion.kind;
      const corpus = service.importCorpus(entry.policy.id, {
        known_bad: [{ ref: knownBad, label: `${labelPrefix} known bad` }],
        known_good: [{ ref: knownGood, label: `${labelPrefix} known good` }],
      }, { now: `2026-07-10T10:${10 + index}:00.000Z` });
      const plan = service.plan(entry.policy.id, { now: `2026-07-10T10:${20 + index}:00.000Z` });
      if (plan.corpus_manifest?.content_hash !== corpus.content_hash) throw new Error("plan did not bind imported corpus manifest");
      const { policy, proof } = service.prove(entry.policy.id, { now: `2026-07-10T10:${30 + index}:00.000Z` });
      const primary = proof.mutation_receipts.find((receipt) => receipt.kind === "primary");
      if (proof.proof_class !== "P3" || policy.authority !== null) throw new Error(`policy ${policy.id} did not remain authority-free P3`);
      if (proof.known_bad.violated !== 1 || proof.known_good.satisfied !== 1) throw new Error(`policy ${policy.id} did not pass imported fixtures`);
      if (!primary?.passed || primary.parseability !== "parseable" || !primary.source_patch) throw new Error(`policy ${policy.id} did not pass source mutation`);
      if (proof.mutation_controls.passed !== 2 || proof.mutation_controls.failed !== 0) throw new Error(`policy ${policy.id} did not pass controls`);
      knownBadCaught += proof.known_bad.violated;
      knownGoodPassed += proof.known_good.satisfied;
      primaryCaught += 1;
      controlsPassed += proof.mutation_controls.passed;
      if (entry.dataClass === "public") {
        publicReceipts.push({
          assertion: entry.policy.assertion.kind,
          policy_id: policy.id,
          corpus_id: corpus.id,
          proof_id: proof.id,
          source_diff_hash: primary.source_patch.diff_hash,
        });
      }
    }

    const cliCorpusReadback = JSON.parse(run(process.execPath, [
      installedCli,
      "policy",
      "corpus",
      cases[0].policy.id,
      "--public-only",
    ], { cwd: repo, env: process.env }));
    if (cliCorpusReadback.id !== service.corpus(cases[0].policy.id, { publicOnly: true }).id) {
      throw new Error("clean-installed CLI corpus readback did not match canonical service record");
    }

    const publicText = ["decisions", "evidence", "policies", "corpora", "plans", "proofs"]
      .map((kind) => allText(join(repo, ".hunch", kind)))
      .join("\n");
    const privateText = allText(privateHome);
    if (publicText.includes("PRIVATE_REHEARSAL_SENTINEL")) throw new Error("private corpus sentinel leaked into public Hunch home");
    if (!privateText.includes("PRIVATE_REHEARSAL_SENTINEL")) throw new Error("private corpus sentinel was not preserved in private home");
    if (existsSync(hookSentinel)) throw new Error("repository hook executed during replay/mutation");
    const worktrees = git(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "));
    if (worktrees.length !== 1) throw new Error("disposable worktree leaked after rehearsal");
    for (const kind of ["worktrees", "mutations"]) {
      const dir = join(repo, ".hunch-cache", kind);
      if (existsSync(dir) && readdirSync(dir).length !== 0) throw new Error(`${kind} session leaked after rehearsal`);
    }

    const report = {
      schema: "hunch.constitution.clean-rehearsal.v1",
      generated_at: new Date().toISOString(),
      package: {
        name: pack.name,
        version: pack.version,
        shasum: pack.shasum,
        integrity: pack.integrity,
        clean_install: true,
      },
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      corpus: {
        policies: cases.length,
        public_policies: publicReceipts.length,
        private_policies: cases.length - publicReceipts.length,
        imported_known_bad: cases.length,
        imported_known_good: cases.length,
        assertion_kinds: [...new Set(cases.map((entry) => entry.policy.assertion.kind))].sort(),
      },
      proofs: {
        p3: cases.length,
        known_bad_caught: knownBadCaught,
        known_good_satisfied: knownGoodPassed,
        source_mutations_caught: primaryCaught,
        controls_passed: controlsPassed,
        authority_grants: 0,
      },
      isolation: {
        clean_home: true,
        network_proxies_unreachable_during_proof: true,
        repository_hooks_executed: false,
        active_worktrees_after_run: worktrees.length,
        transient_sessions_after_run: 0,
        clean_installed_cli_corpus_roundtrip: true,
      },
      privacy: {
        private_fixture_count: 2,
        private_sentinel_in_public_home: false,
        private_sentinel_preserved_in_private_home: true,
      },
      public_receipts: publicReceipts.sort((a, b) => a.assertion.localeCompare(b.assertion)),
    };
    const encoded = JSON.stringify(report, null, 2) + "\n";
    if (outputFile) {
      const target = resolve(projectRoot, outputFile);
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${process.pid}`;
      writeFileSync(temporary, encoded);
      renameSync(temporary, target);
    }
    process.stdout.write(encoded);
  } finally {
    store.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
