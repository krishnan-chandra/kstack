// Cookie flags are owned by the staging edge. This module only emits the
// name/value pair that the edge wraps.
export function buildSessionCookie(sessionId) {
  if (!sessionId) throw new Error("missing session");
  return `sid=${sessionId}`;
}
