#!/usr/bin/env node

const repos = [
  "davesheffer/hunch",
  "gitmem-dev/gitmem",
  "ismaelkedir/knowit",
  "weigibbor/mnemo",
  "oldskultxo/aictx",
  "riponcm/projectmem",
  "Cranot/roam-code",
  "blackwell-systems/knowing",
  "markmhendrickson/neotoma",
];

const distinctivePhrases = [
  "Causal Merge Verdict",
  "corrections become enforced",
  "content-matched constraints",
  "deterministic Change Gate for AI-assisted codebases",
];

let token = process.env.GITHUB_TOKEN?.trim();
// A rejected token must DEGRADE the run, never kill it: ambient CI/proxy tokens
// are often invalid for api.github.com, and the metadata half of this watch
// works unauthenticated. Flipped on the first 401 so every later call skips
// the bad credential instead of failing eight times.
let tokenRejected = false;

function headers() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "hunch-competitive-watch",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token && !tokenRejected ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function github(path) {
  let response = await fetch(`https://api.github.com${path}`, { headers: headers() });
  if (response.status === 401 && token && !tokenRejected) {
    tokenRejected = true;
    process.stderr.write("competitive-watch: GITHUB_TOKEN rejected (401) — continuing unauthenticated; phrase search will be skipped.\n");
    response = await fetch(`https://api.github.com${path}`, { headers: headers() });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).replaceAll("\n", " ");
    throw new Error(`GitHub ${response.status} for ${path}: ${detail}`);
  }
  return response.json();
}

async function repoSnapshot(repo) {
  // One vanished/renamed repo is itself a signal worth a row — never a reason
  // to lose the other seven.
  try {
    const data = await github(`/repos/${repo}`);
    return {
      repo,
      created: data.created_at,
      pushed: data.pushed_at,
      stars: data.stargazers_count,
      forks: data.forks_count,
      issues: data.open_issues_count,
      url: data.html_url,
    };
  } catch (error) {
    return { repo, error: error instanceof Error ? error.message : String(error) };
  }
}

async function phraseSnapshot(phrase) {
  const query = encodeURIComponent(`"${phrase}"`);
  const data = await github(`/search/code?q=${query}&per_page=100`);
  const external = data.items
    .filter((item) => !item.repository.full_name.startsWith("davesheffer/"))
    .map((item) => ({
      repo: item.repository.full_name,
      path: item.path,
      url: item.html_url,
    }));
  return { phrase, total: data.total_count, external };
}

function render(snapshot, phrases) {
  const lines = [
    `# Competitive watch — ${new Date().toISOString()}`,
    "",
    "## Public repository signals",
    "",
    "| Repository | Created | Last push | Stars | Forks | Open issues |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  ];

  for (const item of snapshot) {
    if (item.error) {
      lines.push(`| ${item.repo} | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| [${item.repo}](${item.url}) | ${item.created.slice(0, 10)} | ${item.pushed.slice(0, 10)} | ${item.stars} | ${item.forks} | ${item.issues} |`,
    );
  }
  const failed = snapshot.filter((item) => item.error);
  if (failed.length) {
    lines.push("");
    for (const item of failed) lines.push(`- ⚠ ${item.repo}: ${item.error}`);
  }

  lines.push("", "## Distinctive phrase search", "");
  if (!token) {
    lines.push("Skipped: set `GITHUB_TOKEN` to enable authenticated GitHub code search.");
  } else if (tokenRejected) {
    lines.push("Skipped: `GITHUB_TOKEN` was rejected by api.github.com (401) — repo metadata above was collected unauthenticated. Provide a valid token (e.g. `GITHUB_TOKEN=\"$(gh auth token)\"`) to run the phrase-copy check.");
  } else {
    for (const result of phrases) {
      lines.push(`- **${result.phrase}** — ${result.external.length} external indexed match(es)`);
      for (const match of result.external) {
        lines.push(`  - [${match.repo} · ${match.path}](${match.url})`);
      }
    }
  }

  lines.push(
    "",
    "> Signals are leads, not copying findings. Re-check chronology and substantial similarity before drawing a conclusion.",
  );
  return `${lines.join("\n")}\n`;
}

try {
  const snapshot = [];
  // Sequential on purpose: the first call settles token validity before the
  // rest, and unauthenticated rate limits are too small to burst against.
  for (const repo of repos) snapshot.push(await repoSnapshot(repo));
  const phrases = token && !tokenRejected
    ? await Promise.all(distinctivePhrases.map(phraseSnapshot))
    : [];
  process.stdout.write(render(snapshot, phrases));
} catch (error) {
  process.stderr.write(`competitive-watch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
