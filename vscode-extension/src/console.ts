/**
 * The Hunch Console — a conversational, intent-aware surface over the graph.
 *
 *   • PROACTIVE: opens with a briefing — what needs you (drafts to review,
 *     the live roadmap, open bugs, what's enforcing) as actionable cards.
 *   • UNDERSTANDS: plain text is routed by intent — "why is auth like this"
 *     runs `hunch why`, "record a decision about X" starts a capture
 *     interview, anything else searches the graph. When Copilot models are
 *     available (vscode.lm — the user's existing subscription), they sharpen
 *     the routing; deterministic heuristics are the always-on fallback.
 *   • WRITES THE RIGHT WAY: /capture drills the user one question at a time
 *     (the same grilling protocol Claude Code gets) and commits through the
 *     repo's own `hunch mcp` server (hunch_capture_decision →
 *     hunch_record_decision, with a real capture token). The extension never
 *     writes .hunch/ JSON itself.
 *   • ACTIONABLE: every answer carries chips (next commands, open review,
 *     open the Brain); file paths and record ids are clickable everywhere.
 *
 * Message protocol
 *   webview → ext : ready | run{input} | stop | open{path,line?} | openRecord{id}
 *                 | exec{command} | captureCommit | captureCancel
 *   ext → webview : init{commands,counts} | brief{cards} | say{text,chips?}
 *                 | ask{q,hint,ph,step} | intent{text,chips?} | confirm{summary}
 *                 | begin{run,argv} | line{run,text} | end{run,ok,code,ms}
 *                 | error{message}
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import { spawnHunchProc, type HunchProc } from "./cli.js";
import { HUNCH_COMMANDS, stripAnsi } from "./commands.js";
import { HunchMcp } from "./mcpClient.js";
import { recordFilePath, reviewQueue, type Hunch } from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;
let live: HunchProc | null = null;
let runSeq = 0;
let mcp: HunchMcp | null = null;
let capture: CaptureState | null = null;

/** VS Code commands an action chip may trigger — never arbitrary ids from the webview. */
const CHIP_COMMANDS = new Set(["hunch.autoReview", "hunch.stats", "hunch.graph", "hunch.refresh", "hunch.recordConstraint", "hunch.recordBug"]);
/** Verbs runnable beyond the curated catalog (deterministic, interactively useful). */
const EXTRA_VERBS = new Set(["index"]);

// ---------------------------------------------------------------------------
// Capture interview — the grilling, driven ext-side one question at a time.
// ---------------------------------------------------------------------------
interface CaptureState {
  token: string;
  step: number;
  alts: string[];
  data: { topic?: string; title?: string; decision?: string; context?: string; files?: string[]; status?: "accepted" | "proposed" };
}

const STEPS = ["topic", "title", "decision", "context", "alts", "files", "status"] as const;

export function openConsole(root: string, getHunch: () => Hunch | null, onWrite: () => void): void {
  if (panel) { panel.reveal(vscode.ViewColumn.Active); return; }
  panel = vscode.window.createWebviewPanel("hunchConsole", "Hunch Console", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => {
    live?.kill(); live = null;
    mcp?.dispose(); mcp = null;
    capture = null;
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage((msg: unknown) => void handle(root, msg, getHunch, onWrite));
  panel.webview.html = html();
}

function post(m: unknown): void { void panel?.webview.postMessage(m); }

async function handle(root: string, msg: unknown, getHunch: () => Hunch | null, onWrite: () => void): Promise<void> {
  const m = msg as { type?: string; input?: string; path?: string; line?: number; id?: string; command?: string };
  switch (m?.type) {
    case "ready": init(getHunch); return sendBrief(getHunch);
    case "run": return route(root, String(m.input ?? ""), getHunch, onWrite);
    case "stop": return void live?.kill();
    case "open": return openPath(root, String(m.path ?? ""), m.line);
    case "openRecord": return openRecord(root, String(m.id ?? ""), getHunch);
    case "captureCommit": return commitCapture(root, getHunch, onWrite);
    case "captureCancel": return cancelCapture();
    case "exec":
      if (typeof m.command === "string" && CHIP_COMMANDS.has(m.command)) void vscode.commands.executeCommand(m.command);
      return;
  }
}

function init(getHunch: () => Hunch | null): void {
  const h = getHunch();
  post({
    event: "init",
    commands: [
      { verb: "capture", label: "Capture", detail: "Drill a decision into the graph — the interview, then a real record.", hint: "what you decided", needsArg: false },
      { verb: "brief", label: "Brief", detail: "What needs you right now: drafts, roadmap, bugs, enforcement.", hint: "", needsArg: false },
      ...HUNCH_COMMANDS.map((c) => ({
        verb: c.args[0],
        label: c.label.replace(/\$\([^)]*\)\s*/, ""),
        detail: c.detail,
        hint: c.arg?.placeHolder ?? "",
        needsArg: Boolean(c.arg),
      })),
      { verb: "index", label: "Index", detail: "Re-parse the repo into the symbol/component graph (components are derived, not hand-added).", hint: "", needsArg: false },
    ],
    counts: h ? { decisions: h.decisions.length, constraints: h.constraints.length, bugs: h.bugs.length, components: h.components.length } : null,
  });
}

// ---------------------------------------------------------------------------
// Proactive briefing — the PULSE strip: live badges docked above the input,
// always visible while the chat scrolls. Icon + count; hover expands the
// label; click acts. Re-sent after every run so the numbers never lie.
// ---------------------------------------------------------------------------
function sendBrief(getHunch: () => Hunch | null): void {
  const h = getHunch();
  if (!h) {
    return post({ event: "say", text: "No .hunch/ graph in this workspace yet. Run `hunch init` in a terminal to give this repo a memory.", chips: [] });
  }
  const rq = reviewQueue(h);
  const pending = rq.ready.length + rq.scrutiny.length;
  const roadmap = h.decisions.filter((d) => d.status === "proposed").length;
  const openBugs = h.bugs.filter((b) => b.status !== "fixed").length;
  const blocking = h.constraints.filter((c) => c.severity === "blocking").length;
  post({
    event: "brief",
    badges: [
      { icon: "🗳", count: pending, label: `draft${pending === 1 ? "" : "s"} wait for your yes`, tip: `${rq.ready.length} verified · ${rq.scrutiny.length} need scrutiny — click to triage`, input: "/review", hot: pending > 0 },
      { icon: "🧭", count: roadmap, label: "on the roadmap", tip: "live proposed decisions — shipping one retires it", input: "/now" },
      { icon: "🐞", count: openBugs, label: `open bug${openBugs === 1 ? "" : "s"} in memory`, tip: "root causes recorded — don't reintroduce them", input: "/fragile" },
      { icon: "⛔", count: h.constraints.length, label: `enforcing (${blocking} blocking)`, tip: "the rules every assistant is held to", input: "/status", always: true },
      { icon: "🧠", count: null, label: "the Brain", tip: "the component constellation — click a node, pop its branches", exec: "hunch.graph", always: true },
      { icon: "✦", count: null, label: "capture a decision", tip: "unrecorded decisions get re-litigated by the next session", input: "/capture", always: true },
    ],
  });
}

// ---------------------------------------------------------------------------
// Routing — slash commands, capture flow, or intent-interpreted plain text.
// ---------------------------------------------------------------------------
async function route(root: string, input: string, getHunch: () => Hunch | null, onWrite: () => void): Promise<void> {
  const raw = input.trim();
  if (!raw) return;

  if (capture) return captureAnswer(root, raw, getHunch);

  if (raw.startsWith("/")) {
    const [verb, ...rest] = raw.slice(1).split(/\s+/);
    if (verb === "capture") return startCapture(root, rest.join(" "));
    if (verb === "brief") return sendBrief(getHunch);
    if (verb === "cancel") return cancelCapture();
    const def = HUNCH_COMMANDS.find((c) => c.args[0] === verb);
    if (def) return runArgv(root, [...def.args, ...rest], getHunch, onWrite);
    if (verb && EXTRA_VERBS.has(verb)) return runArgv(root, [verb, ...rest], getHunch, onWrite);
    return post({ event: "error", message: "Unknown command. Type / to see what the console can run." });
  }

  // plain text → interpret intent
  const intent = await interpret(raw, getHunch);
  if (intent.say) return post({ event: "say", text: intent.say, chips: intent.chips ?? [] });
  if (intent.capture !== undefined) return startCapture(root, intent.capture);
  if (intent.brief) return sendBrief(getHunch);
  if (intent.argv) {
    post({
      event: "intent",
      text: `→ hunch ${intent.argv.join(" ")}`,
      chips: intent.altChips ?? [],
    });
    return runArgv(root, intent.argv, getHunch, onWrite);
  }
}

interface Intent { argv?: string[]; capture?: string; brief?: boolean; say?: string; chips?: unknown[]; altChips?: unknown[]; }

async function interpret(raw: string, getHunch: () => Hunch | null): Promise<Intent> {
  const lower = raw.toLowerCase();

  // -- deterministic heuristics first (always-on) ---------------------------
  const whyM = /^(?:why|explain)\s+(?:is\s+|does\s+)?(.+?)(?:\s+(?:the way it is|like this|shaped this way))?\??$/i.exec(raw);
  if (whyM) {
    const target = extractTarget(whyM[1]!, getHunch) ?? whyM[1]!.trim();
    return { argv: ["why", target], altChips: [{ t: "search instead", input: raw.replace(/^why\s+/i, "") }] };
  }
  if (/\b(record|capture|draw up|log|write down)\b.*\b(decision|call|choice)\b/i.test(lower) || /^(decide|capture)\b/.test(lower)) {
    return { capture: raw };
  }
  if (/\b(add|new|create)\b.*\bcomponent/i.test(lower)) {
    return {
      say: "Components aren't hand-added — they're derived from the code itself when the repo is indexed. Re-index to re-derive them, or capture a decision about how a component should be shaped and Hunch will hold the code to it.",
      chips: [{ t: "Re-index the graph", input: "/index" }, { t: "Open the Brain", exec: "hunch.graph" }, { t: "Capture a decision", input: "/capture" }],
    };
  }
  if (/^(what (needs|should|now)|what's (next|waiting)|next|todo|brief|help)\b/i.test(lower)) return { brief: true };

  // -- Copilot-assisted routing (the user's existing subscription) ----------
  const lm = await lmRoute(raw);
  if (lm) return lm;

  // -- default: the graph is searchable — treat it as a question -------------
  return {
    argv: ["query", ...raw.split(/\s+/)],
    altChips: [{ t: "capture as decision", input: `/capture ${raw}` }],
  };
}

/** Pull a file-ish or known-symbol target out of free text. */
function extractTarget(s: string, getHunch: () => Hunch | null): string | null {
  const fileM = /((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})/.exec(s);
  if (fileM) return fileM[1]!.replace(/\\/g, "/");
  const h = getHunch();
  if (h) {
    const word = s.trim().split(/\s+/).find((w) => h.symbols.some((sym) => sym.name === w));
    if (word) return word;
  }
  return null;
}

/** Ask a Copilot model (if the user has one) to map free text onto a verb. */
async function lmRoute(raw: string): Promise<Intent | null> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    const model = models.find((m) => /mini|4o/i.test(m.family)) ?? models[0];
    if (!model) return null;
    const verbs = [...HUNCH_COMMANDS.map((c) => `${c.args[0]}: ${c.detail}`), "capture: record a new decision (interview)", "brief: what needs attention"].join("\n");
    const prompt = [
      `Map the user's request to ONE command for the hunch engineering-memory CLI. Commands:\n${verbs}`,
      `User request: "${raw}"`,
      `Answer with ONLY compact JSON: {"verb":"<verb>","arg":"<argument or empty>"}. If nothing fits use {"verb":"query","arg":"<the request>"}.`,
    ].join("\n\n");
    const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: "Route your Hunch Console input to the right command." });
    let out = "";
    for await (const part of res.text) out += part;
    const j = JSON.parse(out.replace(/^[^{]*/, "").replace(/[^}]*$/, "")) as { verb?: string; arg?: string };
    if (!j.verb) return null;
    if (j.verb === "capture") return { capture: j.arg || raw };
    if (j.verb === "brief") return { brief: true };
    const known = HUNCH_COMMANDS.some((c) => c.args[0] === j.verb) || EXTRA_VERBS.has(j.verb);
    if (!known) return null;
    const argv = [j.verb, ...(j.arg ? j.arg.split(/\s+/) : [])];
    return { argv, altChips: [{ t: "search instead", input: raw }] };
  } catch {
    return null; // no consent / no models / bad JSON — heuristics already ran
  }
}

// ---------------------------------------------------------------------------
// Capture — the interview, then the real MCP write.
// ---------------------------------------------------------------------------
function ask(step: number, q: string, hint = "", ph = ""): void {
  post({ event: "ask", q, hint, ph, step: step + 1, of: STEPS.length });
}

async function startCapture(root: string, seed: string): Promise<void> {
  if (capture) return post({ event: "say", text: "A capture is already running — answer the question above, or /cancel." });
  mcp ??= new HunchMcp(root);
  post({ event: "say", text: seed ? `Let's pin this down: “${seed}”. I'll drill you one question at a time — vague answers get pushed back.` : "Let's capture a decision. One question at a time — the record is only as strong as the interview." });
  let token = "";
  try {
    const protocol = await mcp.call("hunch_capture_decision", seed ? { seed } : {});
    token = /capture_token:"([^"]+)"/.exec(protocol)?.[1] ?? "";
  } catch (e) {
    return post({ event: "error", message: `Couldn't start the capture session: ${(e as Error).message}` });
  }
  capture = { token, step: 0, alts: [], data: {} };
  ask(0, "What's the TOPIC anchor? One topic per decision — short and stable, like “auth-transport” or “vector-storage”.", "this keys drift detection for the decision", "e.g. auth-transport");
}

async function captureAnswer(root: string, raw: string, getHunch: () => Hunch | null): Promise<void> {
  if (!capture) return;
  if (raw === "/cancel") return cancelCapture();
  const c = capture;
  const step = STEPS[c.step];
  switch (step) {
    case "topic": {
      c.data.topic = raw.replace(/\s+/g, "-").toLowerCase();
      // proactive: surface the incumbent so the human decides with open eyes
      try {
        mcp ??= new HunchMcp(root);
        const cur = await mcp.call("hunch_current_decision", { topic: c.data.topic });
        if (!/No current decision/i.test(cur)) post({ event: "say", text: `Heads-up — this topic already has a live decision:\n${cur.split("\n").slice(0, 3).join("\n")}\nRecording a second live one will be refused; your new record can supersede it if that's the intent.` });
      } catch { /* advisory only */ }
      c.step++;
      return ask(c.step, "Title — the decision as a one-line headline.", "", "e.g. Store vectors as a derived layer, never source of truth");
    }
    case "title":
      c.data.title = raw;
      c.step++;
      return ask(c.step, "What did you actually DECIDE? The concrete call, not the background.", "", "we will …");
    case "decision":
      c.data.decision = raw;
      c.step++;
      return ask(c.step, "WHY? What forced this call — the constraint, the failure, the trade-off?", "this becomes the context future sessions read", "because …");
    case "context": {
      c.data.context = raw;
      c.step++;
      const drill = await lmDrill(c) ?? "What alternative did you seriously consider and REJECT — and why not? Add “revisit if …” so the call knows when it expires. Type “done” when there are no more.";
      return ask(c.step, drill, "rejected alternatives are what make a decision enforceable", "rejected X because Y — revisit if Z");
    }
    case "alts": {
      if (raw.toLowerCase() !== "done") {
        c.alts.push(raw);
        if (!/revisit if/i.test(raw)) return ask(c.step, "Good — and when would that rejection expire? Fold a “revisit if …” into it, or type “done”.", "", "revisit if …");
        return ask(c.step, `Captured (${c.alts.length}). Another rejected alternative, or “done”?`, "", "rejected X because Y — or: done");
      }
      c.step++;
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      const rel = active ? nodePath.relative(root, active).replace(/\\/g, "/") : "";
      return ask(c.step, "Which files does this decision touch?", rel ? `Enter = use ${rel} · “skip” = none` : "“skip” = none", "src/a.ts src/b.ts");
    }
    case "files": {
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      const rel = active ? nodePath.relative(root, active).replace(/\\/g, "/") : "";
      c.data.files = raw.toLowerCase() === "skip" ? [] : (raw ? raw.split(/[\s,]+/).filter(Boolean) : (rel ? [rel] : []));
      c.step++;
      return ask(c.step, "Is this DECIDED (accepted — enforced now) or ROADMAP (proposed — intent, shows in /now)?", "", "accepted | proposed");
    }
    case "status": {
      c.data.status = /^p/i.test(raw) ? "proposed" : "accepted";
      if (!c.alts.length && c.data.status === "accepted") {
        post({ event: "say", text: "⚠ No rejected alternatives — the graph can only veto what was explicitly rejected. It'll record, but it's an unattacked decision." });
      }
      return post({
        event: "confirm",
        summary: {
          topic: c.data.topic, title: c.data.title, decision: c.data.decision,
          context: c.data.context, alts: c.alts, files: c.data.files ?? [], status: c.data.status,
        },
      });
    }
  }
}

/** Ask Copilot for ONE sharpened drill question given the answers so far. */
async function lmDrill(c: CaptureState): Promise<string | null> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    const model = models.find((m) => /mini|4o/i.test(m.family)) ?? models[0];
    if (!model) return null;
    const prompt = [
      "You are grilling an engineer to harden a decision record. Given their decision and rationale, ask ONE sharp question that surfaces the strongest alternative they should have considered and rejected. One sentence, direct, no preamble. End with: Type “done” when there are no more.",
      `Decision: ${c.data.decision}`,
      `Rationale: ${c.data.context}`,
    ].join("\n");
    const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: "Sharpen the decision-capture interview." });
    let out = "";
    for await (const part of res.text) out += part;
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function commitCapture(root: string, getHunch: () => Hunch | null, onWrite: () => void): Promise<void> {
  const c = capture;
  if (!c) return;
  capture = null;
  mcp ??= new HunchMcp(root);
  try {
    const result = await mcp.call("hunch_record_decision", {
      decision: {
        title: c.data.title ?? "(untitled)",
        decision: c.data.decision,
        context: c.data.context,
        alternatives_rejected: c.alts,
        related_files: c.data.files ?? [],
        topic: c.data.topic,
        status: c.data.status ?? "accepted",
      },
      capture_token: c.token || undefined,
    });
    post({ event: "say", text: result, chips: [{ t: "/now", input: "/now" }, { t: "Refresh tree", exec: "hunch.refresh" }] });
    onWrite();
    sendBrief(getHunch);
  } catch (e) {
    post({ event: "error", message: `Record failed: ${(e as Error).message}` });
  }
}

function cancelCapture(): void {
  if (!capture) return;
  capture = null;
  post({ event: "say", text: "Capture discarded — nothing was written." });
}

// ---------------------------------------------------------------------------
// CLI runs (unchanged core: stream, linkify, verdict footer)
// ---------------------------------------------------------------------------
function runArgv(root: string, argv: string[], getHunch: () => Hunch | null, onWrite: () => void): void {
  if (live) return;
  const id = ++runSeq;
  const started = Date.now();
  post({ event: "begin", run: id, argv });
  // judging passes (auto-review over many drafts) can legitimately run for many
  // minutes on the subscription CLI — give them a 30-minute ceiling, not 10.
  live = spawnHunchProc(root, argv, (line) => post({ event: "line", run: id, text: stripAnsi(line) }), 1_800_000);
  void live.result.then((res) => {
    live = null;
    if (!res.ok && res.stderr.trim()) post({ event: "line", run: id, text: stripAnsi(res.stderr.trim()) });
    post({ event: "end", run: id, ok: res.ok, code: res.code, ms: Date.now() - started });
    onWrite();
    sendBrief(getHunch); // the pulse never lies — refresh it after every run
  });
}

function openPath(root: string, rel: string, line?: number): void {
  const clean = rel.replace(/[\\/]+$/, "");
  const abs = nodePath.isAbsolute(clean) ? clean : nodePath.join(root, clean);
  if (!fs.existsSync(abs)) return void vscode.window.showInformationMessage(`Hunch: ${clean} is not on disk in this workspace.`);
  const opts: vscode.TextDocumentShowOptions | undefined = line
    ? { selection: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) }
    : undefined;
  void vscode.window.showTextDocument(vscode.Uri.file(abs), opts);
}

function openRecord(root: string, id: string, getHunch: () => Hunch | null): void {
  if (id.startsWith("sym_")) {
    const sym = getHunch()?.symbols.find((s) => s.id === id);
    if (sym) return openPath(root, sym.file);
    return void vscode.window.showInformationMessage(`Hunch: unknown symbol ${id}.`);
  }
  const file = recordFilePath(root, id);
  if (!file) return;
  if (fs.existsSync(file)) void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
  else vscode.window.showInformationMessage(`Hunch: no record file for ${id} (it may live in the private overlay).`);
}

function nonce(): string { return crypto.randomBytes(16).toString("hex"); }

/** The console's HTML (exposed for tests / offline preview; the panel uses it internally). */
export function renderConsoleHtml(): string { return html(); }

function html(): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root{
    --moss:#4e9a7d; --moss-hi:#8fd3b6; --ember:#c96a4f; --amber:#d9a441;
    --bg:var(--vscode-editor-background); --fg:var(--vscode-foreground);
    --panel:var(--vscode-editorWidget-background,rgba(127,127,127,.06));
    --border:var(--vscode-panel-border,rgba(127,127,127,.25));
    --mut:var(--vscode-descriptionForeground,#8a8a8a);
    --mono:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);
    font-size:13px;display:flex;flex-direction:column}

  header{border-bottom:1px solid var(--border);padding:10px 18px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
  h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--moss);box-shadow:0 0 8px var(--moss)}
  #counts{color:var(--mut);font-size:11.5px;font-family:var(--mono)}

  #scroll{flex:1;overflow-y:auto;padding:16px 18px 8px}
  .wrap{max-width:920px;margin:0 auto}

  /* ---- welcome ---- */
  #welcome{margin:4vh auto 18px;text-align:center;max-width:680px}
  #welcome h2{font-weight:600;font-size:15px;letter-spacing:.02em;margin:0 0 6px}
  #welcome p{color:var(--mut);margin:0;line-height:1.6}
  #welcome kbd{font-family:var(--mono);background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px}

  /* ---- the pulse: live badges docked above the input, always in reach ---- */
  #pulse{display:flex;gap:6px;max-width:920px;margin:0 auto 8px;flex-wrap:wrap}
  .pb{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:20px;
    background:var(--panel);padding:3px 10px;cursor:pointer;font-size:11px;color:var(--mut);
    max-width:44px;overflow:hidden;white-space:nowrap;transition:max-width .22s ease,border-color .12s;user-select:none}
  .pb:hover,.pb:focus-visible{max-width:340px;border-color:var(--moss);color:var(--fg);outline:none}
  .pb .n{font-family:var(--mono);font-weight:600;color:var(--moss-hi);font-size:11.5px}
  .pb.zero{opacity:.38}
  .pb.hot{border-color:rgba(78,154,125,.55)}
  .pb.hot .n{color:var(--moss-hi)}
  @keyframes pulseGlow{0%,100%{box-shadow:0 0 0 rgba(78,154,125,0)}50%{box-shadow:0 0 9px rgba(78,154,125,.45)}}
  .pb.hot{animation:pulseGlow 2.6s ease-in-out infinite}
  @media (prefers-reduced-motion: reduce){ .pb{transition:none} .pb.hot{animation:none} }

  /* ---- turns + bubbles ---- */
  .turn{max-width:920px;margin:0 auto 16px}
  .cmdline{font-family:var(--mono);font-size:12px;color:var(--moss-hi);margin-bottom:6px;display:flex;gap:8px;align-items:center}
  .cmdline .p{color:var(--moss);user-select:none}
  .cmdline .rerun{margin-left:auto;color:var(--mut);cursor:pointer;font-size:11px;opacity:0;transition:opacity .12s}
  .turn:hover .rerun{opacity:1}
  .cmdline .rerun:hover{color:var(--moss-hi)}
  .out{border:1px solid var(--border);border-left:3px solid var(--moss);border-radius:8px;background:var(--panel);padding:10px 14px;overflow-x:auto}
  .out.err{border-left-color:var(--ember)}
  .out pre{margin:0;font-family:var(--mono);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
  .out a,.say a{color:var(--moss-hi);text-decoration:none;border-bottom:1px dotted rgba(143,211,182,.4);cursor:pointer}
  .out a:hover,.say a:hover{border-bottom-style:solid}
  .out a.rec,.say a.rec{color:var(--amber);border-bottom-color:rgba(217,164,65,.4)}
  .foot{display:flex;gap:10px;align-items:center;margin-top:6px;font-family:var(--mono);font-size:10.5px;color:var(--mut)}
  .foot .ok{color:var(--moss)} .foot .bad{color:var(--ember)}
  .chips{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
  .chip{border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--mut);
    font-size:10.5px;padding:2px 10px;cursor:pointer;font-family:var(--vscode-font-family)}
  .chip:hover{border-color:var(--moss);color:var(--moss-hi)}
  .spin{display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--moss);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion: reduce){ .spin{animation:none} }

  /* hunch speaking */
  .say{display:flex;gap:10px;align-items:flex-start}
  .say .avatar{width:22px;height:22px;border-radius:50%;flex:0 0 auto;margin-top:2px;
    background:radial-gradient(circle at 38% 32%,#8fd3b6,#2c523f);box-shadow:0 0 8px rgba(78,154,125,.55)}
  .say .body{border:1px solid var(--border);border-radius:10px;border-top-left-radius:3px;background:var(--panel);
    padding:9px 13px;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;min-width:0}
  .say .body .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .say.q .body{border-color:rgba(78,154,125,.5)}
  .say .stepno{font-family:var(--mono);font-size:10px;color:var(--mut);margin-bottom:4px;letter-spacing:.06em}
  .say .hint{color:var(--mut);font-size:11px;margin-top:5px;font-style:italic}
  /* user echo */
  .me{display:flex;justify-content:flex-end}
  .me .body{background:rgba(78,154,125,.13);border:1px solid rgba(78,154,125,.3);border-radius:10px;border-top-right-radius:3px;
    padding:8px 13px;font-size:12.5px;max-width:80%;white-space:pre-wrap;word-break:break-word}
  /* intent bar */
  .intent{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--mut);margin:-8px auto 14px;max-width:920px}
  /* confirm card */
  .confirm{border:1px solid rgba(78,154,125,.5);border-radius:10px;background:var(--panel);padding:13px 15px}
  .confirm h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--moss)}
  .confirm .kv{display:grid;grid-template-columns:86px 1fr;gap:4px 10px;font-size:12px;line-height:1.5}
  .confirm .k{color:var(--mut);font-family:var(--mono);font-size:10.5px;padding-top:2px}
  .confirm .row{display:flex;gap:8px;margin-top:12px}
  .confirm button{font-family:inherit;font-size:12px;border-radius:6px;padding:6px 14px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--fg)}
  .confirm button.rec{background:var(--moss);border-color:var(--moss);color:#08110d;font-weight:600}
  .confirm button.rec:hover{background:var(--moss-hi)}
  .confirm button:hover{border-color:var(--moss)}

  /* ---- dock ---- */
  #dock{border-top:1px solid var(--border);padding:10px 18px 12px;position:relative;background:var(--bg)}
  #inputrow{display:flex;gap:8px;align-items:center;max-width:920px;margin:0 auto}
  #prompt{color:var(--moss);font-family:var(--mono);font-size:13px;user-select:none;white-space:nowrap}
  #in{flex:1;font-family:var(--mono);font-size:13px;color:var(--fg);background:var(--panel);
    border:1px solid var(--border);border-radius:7px;padding:8px 12px;outline:none}
  #in:focus{border-color:var(--moss)}
  #in::placeholder{color:var(--mut);opacity:.7}
  #stop{display:none;border:1px solid var(--ember);color:var(--ember);background:transparent;border-radius:7px;padding:7px 14px;font-size:12px;cursor:pointer;font-family:var(--vscode-font-family)}
  #stop:hover{background:rgba(201,106,79,.12)}
  #hint{max-width:920px;margin:6px auto 0;color:var(--mut);font-size:10.5px;font-family:var(--mono);opacity:.75}

  /* ---- palette ---- */
  #pal{position:absolute;bottom:100%;left:18px;right:18px;max-width:920px;margin:0 auto 6px;display:none;
    background:var(--bg);border:1px solid var(--border);border-radius:9px;overflow:hidden;
    box-shadow:0 -8px 30px rgba(0,0,0,.35);max-height:46vh;overflow-y:auto}
  .pi{display:flex;gap:10px;align-items:baseline;padding:7px 13px;cursor:pointer;border-left:2px solid transparent}
  .pi.sel{background:var(--panel);border-left-color:var(--moss)}
  .pi b{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--moss-hi);white-space:nowrap}
  .pi span{color:var(--mut);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<header>
  <h1><span class="dot"></span> Hunch Console</h1>
  <span id="counts"></span>
</header>
<div id="scroll">
  <div id="welcome">
    <h2>Ask your codebase why.</h2>
    <p>Just type — I'll route it. <kbd>/</kbd> for commands · <kbd>/capture</kbd> to drill a decision into memory · <kbd>↑</kbd> history.<br>
       The pulse below the chat is live — hover a badge, click to act.</p>
  </div>
</div>
<div id="dock">
  <div id="pal"></div>
  <div id="pulse"></div>
  <div id="inputrow">
    <span id="prompt">❯</span>
    <input id="in" placeholder="why is src/store/db.ts like this — or /capture, /now, /check…" autocomplete="off" spellcheck="false">
    <button id="stop">■ Stop</button>
  </div>
  <div id="hint">plain text is routed by intent · reads run the CLI · the one write (/capture) goes through hunch mcp</div>
</div>
<script nonce="${n}">
const vs = (typeof acquireVsCodeApi==='function')?acquireVsCodeApi():{postMessage(){}};
const $ = (id)=>document.getElementById(id);
const scroll=$('scroll'), input=$('in'), pal=$('pal'), stopBtn=$('stop'), promptEl=$('prompt');
const esc=(s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let CMDS=[], history=[], hIdx=-1, palItems=[], palSel=0, busy=false, capturing=false;
const turns=new Map();

const CHIPS={ review:[{t:'Open Review Console',exec:'hunch.autoReview'}],
  'auto-review':[{t:'Open Review Console',exec:'hunch.autoReview'}],
  stats:[{t:'Open value panel',exec:'hunch.stats'}],
  why:[{t:'Open the Brain',exec:'hunch.graph'}],
  now:[{t:'Capture the next intent',input:'/capture'}],
  stale:[{t:'Refresh tree',exec:'hunch.refresh'}],
  check:[{t:'Record an invariant',exec:'hunch.recordConstraint'}] };

window.addEventListener('message',(e)=>{
  const m=e.data;
  if(m.event==='init'){
    CMDS=m.commands;
    if(m.counts) $('counts').textContent = m.counts.decisions+' decisions · '+m.counts.constraints+' invariants · '+m.counts.bugs+' bugs · '+m.counts.components+' components';
  }
  else if(m.event==='brief') pulse(m.badges);
  else if(m.event==='say') say(m.text,m.chips||[]);
  else if(m.event==='ask') askQ(m);
  else if(m.event==='intent') intent(m);
  else if(m.event==='confirm') confirmCard(m.summary);
  else if(m.event==='begin') begin(m.run,m.argv);
  else if(m.event==='line') line(m.run,m.text);
  else if(m.event==='end') end(m.run,m.ok,m.code,m.ms);
  else if(m.event==='error'){ say('✗ '+m.text0||m.message,[]); const t=[...turns.values()].pop(); capturing=false; setPrompt(); }
});

function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }
function addWrap(node){ scroll.appendChild(node); scroll.scrollTop=scroll.scrollHeight; }
function chipsHtml(chips){ return (chips&&chips.length)?'<div class="row">'+chips.map((c,i)=>'<button class="chip" data-i="'+i+'">'+esc(c.t)+'</button>').join('')+'</div>':''; }
function wireChips(node,chips){ node.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{
  const c=chips[+b.dataset.i]; if(!c)return;
  if(c.exec) vs.postMessage({type:'exec',command:c.exec});
  else if(c.input){ input.value=c.input; send(); }
}));}

function pulse(badges){
  const host=$('pulse'); host.innerHTML='';
  badges.forEach(b=>{
    if(b.count===0 && !b.always) { /* keep the slot — dimmed, so the strip is stable */ }
    const cls='pb'+(b.count===0&&!b.always?' zero':'')+(b.hot?' hot':'');
    const n=el('<button class="'+cls+'" title="'+esc(b.tip||'')+'">'+
      '<span>'+esc(b.icon)+'</span>'+(b.count!=null?'<span class="n">'+b.count+'</span>':'')+
      '<span>'+esc(b.label)+'</span></button>');
    n.addEventListener('click',()=>{
      if(b.exec) vs.postMessage({type:'exec',command:b.exec});
      else if(b.input){ input.value=b.input; send(); }
    });
    host.appendChild(n);
  });
}

function say(text,chips){
  const n=el('<div class="turn say"><div class="avatar"></div><div class="body">'+linkify(esc(text))+chipsHtml(chips)+'</div></div>');
  wireChips(n,chips||[]); wire(n); addWrap(n);
}
function askQ(m){
  capturing=true; setPrompt(m.step,m.of);
  const n=el('<div class="turn say q"><div class="avatar"></div><div class="body"><div class="stepno">capture · '+m.step+'/'+m.of+'</div>'+esc(m.q)+(m.hint?'<div class="hint">'+esc(m.hint)+'</div>':'')+'</div></div>');
  addWrap(n);
  input.placeholder=m.ph||'…'; input.focus();
}
function intent(m){
  const n=el('<div class="intent"><span>'+esc(m.text)+'</span></div>');
  if(m.chips&&m.chips.length){ n.insertAdjacentHTML('beforeend',m.chips.map((c,i)=>'<button class="chip" data-i="'+i+'">'+esc(c.t)+'</button>').join('')); wireChips(n,m.chips); }
  addWrap(n);
}
function confirmCard(s){
  capturing=false; setPrompt();
  const kv=(k,v)=>'<div class="k">'+k+'</div><div>'+v+'</div>';
  const n=el('<div class="turn"><div class="confirm"><h3>🧭 ready to record</h3><div class="kv">'+
    kv('topic',esc(s.topic))+kv('title','<b>'+esc(s.title)+'</b>')+kv('decision',esc(s.decision))+
    kv('why',esc(s.context))+
    kv('rejected',s.alts.length?s.alts.map(esc).join('<br>'):'<i>none — unattacked</i>')+
    kv('files',s.files.length?s.files.map(esc).join(', '):'—')+kv('status',esc(s.status))+
    '</div><div class="row"><button class="rec">✓ Record it</button><button class="no">Discard</button><button class="ed">Keep drilling</button></div></div></div>');
  n.querySelector('.rec').addEventListener('click',()=>{ n.querySelectorAll('button').forEach(b=>b.disabled=true); vs.postMessage({type:'captureCommit'}); });
  n.querySelector('.no').addEventListener('click',()=>{ n.remove(); vs.postMessage({type:'captureCancel'}); });
  n.querySelector('.ed').addEventListener('click',()=>{ n.remove(); vs.postMessage({type:'run',input:'/capture'}); });
  addWrap(n);
}
function setPrompt(step,of){ promptEl.textContent = step?('🎤 '+step+'/'+of):'❯'; }

function begin(id,argv){
  busy=true; stopBtn.style.display='block';
  const w=$('welcome'); if(w) w.remove();
  const verb=argv[0];
  const t=el('<div class="turn" data-run="'+id+'"><div class="cmdline"><span class="p">❯</span> hunch '+esc(argv.join(' '))+
    '<span class="rerun" title="Run again">↻ re-run</span></div><div class="out"><pre></pre></div>'+
    '<div class="foot"><span class="spin"></span><span class="st">running…</span><span class="chips"></span></div></div>');
  t.querySelector('.rerun').addEventListener('click',()=>{ if(!busy){ input.value='/'+argv.join(' '); send(); } });
  addWrap(t);
  const rec={pre:t.querySelector('pre'),out:t.querySelector('.out'),foot:t.querySelector('.foot'),verb,timer:null};
  // live elapsed ticker — a long judging pass should never look stalled
  const st=t.querySelector('.st'), t0=Date.now();
  rec.timer=setInterval(()=>{ const s=Math.round((Date.now()-t0)/1000);
    st.textContent='running… '+(s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'); },1000);
  // long verbs get their live surface immediately, not only at the end
  const early=CHIPS[verb];
  if(early&&(verb==='auto-review'||verb==='review')){
    t.querySelector('.chips').innerHTML=early.map((c,i)=>'<button class="chip" data-i="'+i+'">'+esc(c.t)+' (live)</button>').join('');
    wireChips(t.querySelector('.chips'),early);
  }
  turns.set(id,rec);
}
function line(id,text){
  const t=turns.get(id); if(!t)return;
  const atBottom = scroll.scrollTop+scroll.clientHeight >= scroll.scrollHeight-40;
  t.pre.insertAdjacentHTML('beforeend', linkify(esc(text))+'\\n');
  if(atBottom) scroll.scrollTop=scroll.scrollHeight;
}
function end(id,ok,code,ms){
  busy=false; stopBtn.style.display='none'; input.focus();
  const t=turns.get(id); if(!t)return;
  if(t.timer){ clearInterval(t.timer); t.timer=null; }
  if(!ok) t.out.classList.add('err');
  if(!t.pre.textContent.trim()) t.pre.textContent='(no output)';
  const chips=CHIPS[t.verb]||[];
  t.foot.innerHTML=(ok?'<span class="ok">✓ done</span>':'<span class="bad">✗ exit '+esc(code)+'</span>')+
    '<span>'+(ms/1000).toFixed(1)+'s</span><span class="chips">'+chips.map((c,i)=>'<button class="chip" data-i="'+i+'">'+esc(c.t)+'</button>').join('')+'</span>';
  wireChips(t.foot,chips);
  wire(t.pre);
}

const RE_REC=/\\b((?:dec|con|bug|comp|sym)_[0-9a-f]{6,})\\b/g;
const RE_FILE=/(?<![\\w/])((?:[A-Za-z0-9_.-]+\\/)+[A-Za-z0-9_.-]+\\.[A-Za-z0-9]{1,8})(?::(\\d+))?/g;
function linkify(s){
  return s.replace(RE_REC,'<a class="rec" data-rec="$1">$1</a>')
          .replace(RE_FILE,(m,p,l)=>'<a data-path="'+p+'"'+(l?' data-line="'+l+'"':'')+'>'+m+'</a>');
}
function wire(node){
  node.querySelectorAll('a[data-rec]').forEach(a=>a.addEventListener('click',()=>vs.postMessage({type:'openRecord',id:a.dataset.rec})));
  node.querySelectorAll('a[data-path]').forEach(a=>a.addEventListener('click',()=>vs.postMessage({type:'open',path:a.dataset.path,line:a.dataset.line?+a.dataset.line:undefined})));
}

function send(){
  const v=input.value.trim();
  if(!v||busy)return;
  history.push(v); hIdx=history.length;
  if(capturing) addWrap(el('<div class="turn me"><div class="body">'+esc(v)+'</div></div>'));
  vs.postMessage({type:'run',input:v});
  input.value=''; hidePal();
  if(!capturing) input.placeholder='why is src/store/db.ts like this — or /capture, /now, /check…';
}
stopBtn.addEventListener('click',()=>vs.postMessage({type:'stop'}));

function showPal(filter){
  palItems=CMDS.filter(c=>c.verb.startsWith(filter));
  if(!palItems.length){ hidePal(); return; }
  palSel=Math.min(palSel,palItems.length-1);
  pal.innerHTML=palItems.map((c,i)=>'<div class="pi'+(i===palSel?' sel':'')+'" data-i="'+i+'"><b>/'+esc(c.verb)+(c.needsArg?' &lt;'+esc(c.hint||'arg')+'&gt;':'')+'</b><span>'+esc(c.detail)+'</span></div>').join('');
  pal.style.display='block';
  pal.querySelectorAll('.pi').forEach(el2=>el2.addEventListener('click',()=>pick(+el2.dataset.i)));
}
function hidePal(){ pal.style.display='none'; palItems=[]; palSel=0; }
function pick(i){
  const c=palItems[i]; if(!c)return;
  input.value='/'+c.verb+(c.needsArg?' ':'');
  hidePal(); input.focus();
  if(!c.needsArg) send();
}

input.addEventListener('input',()=>{
  const v=input.value;
  if(v.startsWith('/')&&!v.includes(' ')&&!capturing) showPal(v.slice(1));
  else hidePal();
});
input.addEventListener('keydown',(e)=>{
  if(pal.style.display==='block'){
    if(e.key==='ArrowDown'){ e.preventDefault(); palSel=Math.min(palSel+1,palItems.length-1); showPal(input.value.slice(1)); return; }
    if(e.key==='ArrowUp'){ e.preventDefault(); palSel=Math.max(palSel-1,0); showPal(input.value.slice(1)); return; }
    if(e.key==='Tab'||e.key==='Enter'){ e.preventDefault(); pick(palSel); return; }
    if(e.key==='Escape'){ hidePal(); return; }
  }
  if(e.key==='Escape'&&capturing&&!input.value){ vs.postMessage({type:'run',input:'/cancel'}); capturing=false; setPrompt(); return; }
  if(e.key==='Enter'){ e.preventDefault(); send(); }
  else if(e.key==='ArrowUp'&&!input.value){ if(hIdx>0){ hIdx--; input.value=history[hIdx]||''; } }
  else if(e.key==='ArrowDown'&&hIdx<history.length){ hIdx++; input.value=history[hIdx]||''; }
});

input.focus();
vs.postMessage({type:'ready'});
</script></body></html>`;
}
