/**
 * The single rule for "is this hook command Hunch's own?", shared by every hook
 * writer (scaffold.ts for Claude Code's .claude/settings.json, providers.ts for
 * Cursor/Codex/VS Code/Windsurf/Antigravity). One rule, because each writer
 * deletes what it classifies as ours, and a writer that guesses wide deletes the
 * user's hooks (con_8460b6770f).
 */

/** Does one command string invoke Hunch's own hook?
 *
 * Anchored to the shapes hookCommand() / resolveInvocation() write — a Hunch
 * launcher (the pinned npm package spec, or a …/dist|src/cli/index.js|ts path for
 * source installs) plus a `hook` tail, tokens quoted or bare. The old unanchored
 * /index\.(js|ts)/ + /\bhook\b/ pair classified FOREIGN entries like
 * `node ./hook/index.js` as ours and silently deleted them, violating the
 * leave-every-foreign-hook-in-place contract (con_8460b6770f, issue #41).
 *
 * `requireProvider` distinguishes the two writers. Provider configs always carry
 * `hook --provider <name>`, so their tail must too; only the LEGACY fully-quoted
 * form (written before the quoting fix, and by hunch versions that predate
 * --provider) may omit it, and its quotes keep it unambiguous. Claude Code's own
 * settings.json never carries --provider, so a bare `hook` tail is all that is
 * left to match on — and a bare tail alone is far too weak, so there the WHOLE
 * command must be one of the two shapes `hunch init` has ever written (see
 * isClaudeCodeHookCommand). */
export function isHunchHookCommand(command: string, requireProvider: boolean): boolean {
  if (!requireProvider) return isClaudeCodeHookCommand(command);
  const published = /@davesheffer\/hunch/.test(command);
  const launcher = published || /(?:dist|src)[\\/]+cli[\\/]+index\.(?:js|ts)(?=["\s]|$)/.test(command);
  const legacyTail = /\s"hook"(?:\s+"--provider"\s+"[a-z]+")?\s*$/.test(command);
  return launcher && (legacyTail || /\s"?hook"?\s+"?--provider"?\s+"?[a-z]+"?\s*$/.test(command));
}

const ABSOLUTE = String.raw`(?:\/|[A-Za-z]:[\\/]|\\\\)`;
const CLI_ENTRY = String.raw`[\\/](?:dist|src)[\\/]+cli[\\/]+index\.(?:js|ts)`;
const SOURCE_HOOK = new RegExp(
  String.raw`^\s*(?:"?npx(?:\.cmd)?"?\s+"?tsx"?|"[^"]+"|\S+)\s+(?:"${ABSOLUTE}[^"]*${CLI_ENTRY}"|${ABSOLUTE}\S*${CLI_ENTRY})\s+"?hook"?\s*$`,
);

/** The bare-`hook` shapes written into .claude/settings.json, matched as a whole
 *  command so nothing chained before or after one can be swept out with it:
 *
 *   - published: `npx -y --package=[hunch-exact@npm:]@davesheffer/hunch[@v] hunch hook`
 *   - source / `npm link` / dev: `<runtime> <ABSOLUTE …/dist|src/cli/index.js|ts> hook`
 *
 *  Quoting is NOT the discriminator. shellInvocation() leaves a safe token bare, so
 *  since v1.21.1 a POSIX source install writes `/usr/bin/node /abs/dist/cli/index.js
 *  hook` with no quotes at all (quotes appear only for a space or a Windows
 *  backslash, and on every token before v1.21.1). Requiring them left our own hook
 *  in place and appended another on each `hunch init`. What every version shares is
 *  an absolute entry path — resolveInvocation() derives it from import.meta.url —
 *  and that is what keeps a tool which merely shares the layout
 *  (`node tools/lint/dist/cli/index.js hook`) foreign; deleting it was issue #310.
 *  A foreign tool invoked by ABSOLUTE path with this exact layout and a lone `hook`
 *  argument is still indistinguishable by string alone. */
function isClaudeCodeHookCommand(command: string): boolean {
  const published = /^\s*"?npx(?:\.cmd)?"?\s+/i.test(command)
    && /--package=(?:hunch-exact@npm:)?@davesheffer\/hunch(?:@[^"\s]+)?(?=["\s])/.test(command)
    && /\s"?hunch"?\s+"?hook"?\s*$/.test(command);
  return published || SOURCE_HOOK.test(command);
}
