// Usage: node gate-a4-tooltime.mjs <out.json> [runsDir]
// Per run: longest tool call (s), total tool time (s), full-suite run count + time (s),
// full suite = a shell test call that hit the 10-min Bash cap (>=590 s); via `task verify` if the command used it.
// Tool duration = user tool_result timestamp - assistant tool_use timestamp (main thread only).
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.argv[3] ?? 'C:/bench-out/pilot5-gate-a4/runs';
const out = [];
for (const task of fs.readdirSync(ROOT)) {
  for (const run of fs.readdirSync(path.join(ROOT, task))) {
    const tf = path.join(ROOT, task, run, 'transcript.jsonl');
    if (!fs.existsSync(tf)) continue;
    const lines = fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const uses = new Map();
    let longest = 0, longestName = '', total = 0, full = 0, fullS = 0, viaVerify = 0, fable = 0;
    for (const o of lines) {
      if (o.type === 'assistant' && !o.parent_tool_use_id) {
        for (const c of o.message?.content ?? []) if (c.type === 'tool_use') {
          uses.set(c.id, { t: Date.parse(o.timestamp), name: c.name, input: c.input });
          if (c.name === 'Skill' && /fable/.test(JSON.stringify(c.input))) fable++;
        }
      }
      if (o.type === 'user' && !o.parent_tool_use_id) {
        for (const c of o.message?.content ?? []) if (c.type === 'tool_result' && uses.has(c.tool_use_id)) {
          const u = uses.get(c.tool_use_id);
          const s = (Date.parse(o.timestamp) - u.t) / 1000;
          if (!(s >= 0)) continue;
          total += s;
          if (s > longest) { longest = s; longestName = u.name; }
          const cmd = u.input?.command ?? '';
          if ((u.name === 'Bash' || u.name === 'PowerShell') && s >= 590 && /npm (run )?test|run-tests|tsx --test/.test(cmd)) {
            full++; fullS += s; if (/task verify/.test(cmd)) viaVerify++;
          }
        }
      }
    }
    const [rep, ...armParts] = run.split('-');
    out.push({ task, rep: +rep, arm: armParts.join('-'), longest_s: Math.round(longest), longest_tool: longestName, tool_s: Math.round(total), full_suite_runs: full, full_suite_s: Math.round(fullS), full_via_verify: viaVerify, fable });
  }
}
fs.writeFileSync(process.argv[2] ?? 'tooltime.json', JSON.stringify(out, null, 1));
console.table(out);
