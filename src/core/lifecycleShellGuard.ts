/**
 * Best-effort refusal of rule-lifecycle commands typed from an agent's shell.
 * Only a person approves a draft, clears a challenge, replaces or retires a rule.
 * Scripts and indirection can still bypass this; it is an early warning, not a sandbox.
 * The CLI itself enforces the same rule (src/core/personGate.ts); this only fails fast.
 */

/** Drop heredoc bodies (lines after `<<WORD` up to the WORD line): they are data, not commands. */
function stripHeredocs(command: string): string {
  const lines = command.split(/\r?\n/);
  const out: string[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    out.push(line);
    const words = heredocWords(line);
    for (const w of words) {
      while (n + 1 < lines.length) {
        n++;
        if (lines[n]!.trim() === w) break;
      }
    }
  }
  return out.join("\n");
}

/** Heredoc delimiters opened on one line, ignoring `<<` inside quotes and here-strings (`<<<`). */
function heredocWords(line: string): string[] {
  const words: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = /^<<-?\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|()<>]+))/.exec(line.slice(i));
      if (m) { words.push((m[1] ?? m[2] ?? m[3])!); i += m[0].length - 1; }
    }
  }
  return words;
}

/** Split a command into quote-aware segments (on newlines ; & | ( ) { } backtick), each a token list. */
function segments(command: string): string[][] {
  const out: string[][] = [];
  let toks: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  const endTok = () => { if (has) toks.push(cur); cur = ""; has = false; };
  const endSeg = () => { endTok(); if (toks.length) out.push(toks); toks = []; };
  const text = stripHeredocs(command);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i]!;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < text.length) {
      // A Windows path separator inside a path-like token (a dot-relative or drive path) stays
      // literal; every other backslash is a bash escape.
      if (/[A-Za-z0-9._-]/.test(text[i + 1]!) && (/[\\/:]/.test(cur) || cur.startsWith("."))) cur += c;
      else cur += text[++i]!;
      has = true; continue;
    }
    if (";|&\n\r(){}`".includes(c)) { endSeg(); continue; }
    if (c === " " || c === "\t") { endTok(); continue; }
    cur += c; has = true;
  }
  endSeg();
  return out;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd"]);
const DATA_HEADS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "cat", "man", "which", "where", "type", "head", "tail"]);
const VALUE_OPTS = new Set(["--reason", "-r", "--by", "--note", "--cwd", "--root", "--message", "-m"]);
const norm = (t: string) => t.split(String.fromCharCode(92)).join("/");
const baseName = (t: string | undefined) => norm(t ?? "").replace(/^.*\//, "").replace(/\.(cmd|exe|ps1)$/i, "").toLowerCase();

/** True when this token invokes the Hunch CLI. */
function isInvocation(t: string): boolean {
  if (baseName(t) === "hunch") return true;
  if (t === "@davesheffer/hunch" || /^@davesheffer\/hunch@[^/]+$/.test(t)) return true;
  const p = norm(t);
  const m = /(?:^|\/)(?:dist\/cli\/index(?:\.bundle)?\.js|src\/cli\/index\.ts)$/.exec(p);
  if (!m) return false;
  const before = p.slice(0, m.index).split("/").filter((s) => s && s !== "." && s !== "..");
  const hasDir = p.slice(0, m.index).split("/").some((s) => s && s !== ".");
  return !hasDir || before.some((s) => /hunch/i.test(s));
}

function lifecycleSubcommand(args: string[]): boolean {
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith("-")) {
      if (VALUE_OPTS.has(a)) k++;
      continue;
    }
    pos.push(a);
  }
  const sub = pos[0];
  if (sub === "replace" || sub === "retire-constraint") return true;
  if (sub === "challenge") return pos.slice(1).includes("clear");
  if (sub === "record-constraint") return true;
  if (sub === "edit" || sub === "link") return pos.slice(1).some((a) => a.startsWith("con_"));
  if (sub === "review") return args.some((a) => a === "--confirm" || a.startsWith("--confirm=") || a === "--unconfirm" || a.startsWith("--unconfirm="));
  if (sub === "remove" || sub === "restore") return pos.slice(1).some((a) => a.startsWith("con_"));
  return false;
}

/** The reason to refuse `command`, or null when it is allowed. */
export function refusedLifecycleCommand(command: string, depth = 0): string | null {
  const reason = (shown: string) => `Only a person can approve a draft, clear a challenge, replace, retire, edit or re-link a rule. Ask the user to run: ${shown} (use the Nuryel UI or a human terminal; the hunch CLI will refuse this too when it is not run by a person)`;
  for (const tokens of segments(command)) {
    let h = 0;
    while (h < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[h]!)) h++;
    if (DATA_HEADS.has(baseName(tokens[h]))) continue;
    if (depth < 3) {
      for (let k = 0; k < tokens.length; k++) {
        if (!SHELLS.has(baseName(tokens[k]))) continue;
        const c = tokens.findIndex((t, j) => j > k && (/^-[a-z]*c[a-z]*$/i.test(t) || /^\/c$/i.test(t)));
        if (c >= 0 && tokens[c + 1] !== undefined) {
          const inner = refusedLifecycleCommand(tokens[c + 1]!, depth + 1);
          if (inner) return inner;
        }
        break;
      }
    }
    let i = tokens.findIndex(isInvocation);
    if (i < 0) continue;
    while (i + 1 < tokens.length && isInvocation(tokens[i + 1]!)) i++;
    if (lifecycleSubcommand(tokens.slice(i + 1))) return reason(tokens.slice(i).join(" "));
  }
  return null;
}
