import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedTeamGitEnv,
  readTeamConfig,
  safeGitUrl,
  writeTeamConfig,
} from "../src/integrations/team.js";

test("shared Git environment drops executable transport, prompt, template, and repository selectors", () => {
  const keys = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `/hostile/${key}`;
    const env = boundedTeamGitEnv();
    for (const key of keys) assert.equal(env[key], undefined, key);
    assert.equal(env.GIT_ALLOW_PROTOCOL, "https:ssh:git:file");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("team repository URL gate preserves credential-free supported transports", () => {
  const accepted = [
    "https://github.com/team/memory.git",
    "https://git.example.test:8443/team/memory.git",
    "ssh://git@git.example.test/team/memory.git",
    "ssh://git.example.test/team/memory.git",
    "git://git.example.test/team/memory.git",
    "git@github.com:team/memory.git",
    "/mnt/team memory/memory.git",
    "C:\\team memory\\memory.git",
    "\\\\server\\team memory\\memory.git",
  ];

  for (const url of accepted) assert.equal(safeGitUrl(url), url, url);
});

test("team repository URL gate rejects committed credentials and secret-bearing suffixes", () => {
  const rejected = [
    "https://alice@github.com/team/memory.git",
    "https://alice:secret@github.com/team/memory.git",
    "https://alice%3Asecret@github.com/team/memory.git",
    "http://alice:secret@example.test/team/memory.git",
    "ssh://git:secret@git.example.test/team/memory.git",
    "ssh://git:%73ecret@git.example.test/team/memory.git",
    "ssh://git:@git.example.test/team/memory.git",
    "ssh://git%3Asecret@git.example.test/team/memory.git",
    "git://alice@git.example.test/team/memory.git",
    "git://alice:secret@git.example.test/team/memory.git",
    "https:github.com/team/memory.git",
    "https:\\github.com\\team\\memory.git",
    "https:///github.com/team/memory.git",
    "https://github.com/team/memory.git?access_token=secret",
    "https://github.com/team/memory.git#access_token=secret",
    "ssh://git@git.example.test/team/memory.git?token=secret",
    "git://git.example.test/team/memory.git#token=secret",
    "git@github.com:team/memory.git?token=secret",
    "/mnt/team/memory.git?token=secret",
    "C:\\team\\memory.git#token=secret",
    "\\\\server\\team\\memory.git?token=secret",
  ];

  for (const url of rejected) assert.equal(safeGitUrl(url), null, url);
});

test("invalid team repository writes are side-effect-free", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-url-write-"));
  try {
    const root = join(base, "existing");
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeTeamConfig(root, { shared_repo: "https://github.com/team/memory.git" });
    const file = join(root, ".hunch", "team.json");
    const before = readFileSync(file, "utf8");

    for (const shared_repo of [
      "ssh://git:secret@git.example.test/team/memory.git",
      "git://secret@git.example.test/team/memory.git",
      "https://github.com/team/memory.git?token=secret",
    ]) {
      assert.throws(
        () => writeTeamConfig(root, { shared_repo }),
        /refusing to write unsafe team repository URL/,
      );
      assert.equal(readFileSync(file, "utf8"), before, shared_repo);
    }

    const absentRoot = join(base, "absent");
    mkdirSync(absentRoot);
    assert.throws(
      () => writeTeamConfig(absentRoot, {
        shared_repo: "https://alice:secret@example.test/team/memory.git",
      }),
      /refusing to write unsafe team repository URL/,
    );
    assert.equal(existsSync(join(absentRoot, ".hunch")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("team repository config read and valid canonical write share the same gate", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-team-url-read-"));
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeTeamConfig(root, { shared_repo: "  ssh://git@git.example.test/team/memory.git  " });
    assert.deepEqual(readTeamConfig(root), {
      shared_repo: "ssh://git@git.example.test/team/memory.git",
    });

    const file = join(root, ".hunch", "team.json");
    for (const shared_repo of [
      "ssh://git:secret@git.example.test/team/memory.git",
      "git://secret@git.example.test/team/memory.git",
      "https://github.com/team/memory.git#token=secret",
    ]) {
      writeFileSync(file, JSON.stringify({ shared_repo }) + "\n");
      assert.equal(readTeamConfig(root), null, shared_repo);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("team repository config read refuses links and oversized startup input", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-config-file-safety-"));
  try {
    const root = join(base, "repo");
    const hunch = join(root, ".hunch");
    mkdirSync(hunch, { recursive: true });
    const file = join(hunch, "team.json");
    const outside = join(base, "outside-team.json");
    writeFileSync(outside, JSON.stringify({ shared_repo: "/outside/memory.git" }));
    symlinkSync(outside, file);
    assert.equal(readTeamConfig(root), null, "startup never follows a committed team.json symlink");

    rmSync(file);
    writeFileSync(file, `${" ".repeat(64 * 1024)}x`);
    assert.equal(readTeamConfig(root), null, "startup never ingests an unbounded committed pointer");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
