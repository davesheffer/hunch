/** Canonical line endings for parsers that do not expose source offsets. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?|\n/g, "\n");
}

/** Remove the CR retained by split("\n") without changing source offsets. */
export function lineContent(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Length of the line break (CRLF, CR, or LF) starting at `at`, or 0. */
export function eolLengthAt(text: string, at: number): number {
  if (text[at] === "\r") return text[at + 1] === "\n" ? 2 : 1;
  return text[at] === "\n" ? 1 : 0;
}

/** Read logical lines while keeping offsets in the original UTF-16 source. */
export function* sourceLines(text: string): Generator<{ content: string; start: number; end: number }> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    const end = i;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    yield { content: text.slice(start, end), start, end };
    start = i + 1;
  }
  yield { content: text.slice(start), start, end: text.length };
}

/** The terminator ("\r\n" or "\n") of the line containing offset `at`; LF when that
 *  line has none or ends in a lone CR. Picks the EOL a generated block is emitted in. */
export function lineEolAt(text: string, at = 0): string {
  const m = /[\r\n]/.exec(text.slice(at));
  return m && eolLengthAt(text, at + m.index) === 2 ? "\r\n" : "\n";
}

/** `text` (generated, so any line breaks are ours) with every line break as `eol`. */
export function withEol(text: string, eol: string): string {
  const lf = normalizeEol(text);
  return eol === "\n" ? lf : lf.replace(/\n/g, eol);
}
