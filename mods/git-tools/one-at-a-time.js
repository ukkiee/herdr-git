// A slow read asked for once per step, run one at a time. Pure: no herdr import, so node
// tests it (one-at-a-time.test.mjs).
//
// oneAtATime(run) → ask(arg) → Promise<run's answer | undefined>
//   run(arg) with at most one going. An ask while one runs waits; a newer ask replaces it,
//   and the one replaced resolves with undefined without running. A run that fails fails its
//   own ask, and the next still runs.
//   Commit details asks for the branches that contain each commit picked (a walk of every
//   ref) while arrowing through the log: each walk holds one of the git runner's few slots
//   (git.js PARALLEL) until it ends, so walks for commits already passed would keep the
//   newest commit's files waiting.
//   Make one per screen: its turn is that screen's alone (never at module level, where one
//   copy's run would start another copy's work).
export function oneAtATime(run) {
  let going = false, next = null;
  const start = (arg, ok, no) => {
    going = true;
    Promise.resolve()
      .then(() => run(arg))
      .then(ok, no)
      .finally(() => {
        going = false;
        if (next) { const n = next; next = null; start(n.arg, n.ok, n.no); }
      });
  };
  return (arg) => new Promise((ok, no) => {
    if (!going) { start(arg, ok, no); return; }
    next?.ok(undefined);
    next = { arg, ok, no };
  });
}
