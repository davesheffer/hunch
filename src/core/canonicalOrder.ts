/** Locale-free UTF-16 code-unit ordering for content-addressed artifacts.
 * Never use localeCompare where ordering contributes to a hash or selection. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
