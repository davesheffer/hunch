let input: Promise<string> | undefined;

/** Keep the original bytes available if lightweight dispatch defers to the full
 * handler. A TTY resolves empty so an interactive hook never waits for input. */
export function readStdin(): Promise<string> {
  return input ??= new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
