// Process-lifecycle helpers for tying the canvas server to the agent host.

/** True when the server was started under a real parent (the agent host) and
 *  has since been reparented to init (`ppid === 1`) — i.e. the host died
 *  without closing our stdin or signalling us, so the canvas would otherwise
 *  outlive the session. Guarded on the initial ppid so a server intentionally
 *  launched directly under init (ppid 1 from the start, e.g. a container entry
 *  point) is never self-terminated. */
export function isOrphaned(initialPpid: number, currentPpid: number): boolean {
  return initialPpid !== 1 && currentPpid === 1;
}
