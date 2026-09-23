/** Canonical line endings for parsers that do not expose source offsets. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?|\n/g, "\n");
}

/** Remove the CR retained by split("\n") without changing source offsets. */
export function lineContent(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
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
