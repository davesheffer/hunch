/**
 * Capture-session tokens (decision-grounding, DESIGN §5 Stage 1 / §9.3).
 *
 * hunch_capture_decision issues a short-lived token; the commit path consumes it, so a
 * decision written through the capture front door is provably the tail of an interview
 * — the identity-principle guard against a silent, un-interviewed write. In-memory (the
 * MCP server is long-lived); tokens are one-time-use and expire so an abandoned
 * interview can't leak. Absence of a token never BLOCKS a write yet (staged
 * deprecation §9.3) — the caller decides how to treat an un-gated write.
 */
const CAPTURE_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min
const sessions = new Map<string, number>(); // token -> issuedAt (epoch ms)

/** Issue a token stamped `now` (epoch ms). Prunes expired tokens first so the map can't
 *  grow unbounded across a long server life. `mint` supplies the random id (injectable
 *  for tests); the call site passes crypto.randomUUID. */
export function issueCaptureToken(mint: () => string, now: number): string {
  for (const [tok, at] of sessions) if (now - at > CAPTURE_TOKEN_TTL_MS) sessions.delete(tok);
  const token = mint();
  sessions.set(token, now);
  return token;
}

/** Consume a token iff it is a live, unexpired capture session. One-time use: a second
 *  consume of the same token returns false. */
export function consumeCaptureToken(token: string | undefined, now: number): boolean {
  if (!token) return false;
  const at = sessions.get(token);
  if (at === undefined) return false;
  sessions.delete(token);
  return now - at <= CAPTURE_TOKEN_TTL_MS;
}

export { CAPTURE_TOKEN_TTL_MS };
