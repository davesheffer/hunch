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
];

const distinctivePhrases = [
  "Causal Merge Verdict",
  "corrections become enforced",
  "content-matched constraints",
  "deterministic Change Gate for AI-assisted codebases",
];

const token = process.env.GITHUB_TOKEN?.trim();
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "hunch-competitive-watch",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).replaceAll("\n", " ");
    throw new Error(`GitHub ${response.status} for ${path}: ${detail}`);
  }
  return response.json();
}

async function repoSnapshot(repo) {
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
}

async function phraseSnapshot(phrase) {
  const query = encodeURIComponent(`\"${phrase}\"`);
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
    lines.push(
      `| [${item.repo}](${item.url}) | ${item.created.slice(0, 10)} | ${item.pushed.slice(0, 10)} | ${item.stars} | ${item.forks} | ${item.issues} |`,
    );
  }

  lines.push("", "## Distinctive phrase search", "");
  if (!token) {
    lines.push("Skipped: set `GITHUB_TOKEN` to enable authenticated GitHub code search.");
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
  const snapshot = await Promise.all(repos.map(repoSnapshot));
  const phrases = token
    ? await Promise.all(distinctivePhrases.map(phraseSnapshot))
    : [];
  process.stdout.write(render(snapshot, phrases));
} catch (error) {
  process.stderr.write(`competitive-watch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
