// The edit facts a commit menu last read (git-rewrite.js readEditFacts), kept so the next
// right-click on the same commits opens with its items settled. Pure: no herdr import
// (facts-cache.test.mjs).
//
// Facts are kept with the refs' state they were read at (git-log.js readRefsState, which
// the Log panel reads on every poll): they hold while no branch, tag or HEAD has moved.
// What that state doesn't show (an operation begun, files changed) git-tools' own writes
// announce, and the panel clears the cache then; the menu also reads again behind every
// opening and corrects what changed.

// How many sets of commits are kept: right-clicks move among a few nearby commits.
export const CACHE_MAX = 32;

// factsKey(repo, hashes) → the key of `hashes` (in their order) in the repository `repo`
// ({ root, on }), or null when there is nothing to key.
export function factsKey(repo, hashes) {
  if (!repo?.root || !hashes?.length) return null;
  return `${repo.on ?? ""}\0${repo.root}\0${hashes.join(" ")}`;
}

// factsCache(max) → { get(key, refs), put(key, refs, facts), clear(), size() }
//   get: the facts kept for `key` at the refs' state `refs`, or null (none, another state,
//   or no state known). put: keeps facts that were read (ok) at a known state, replacing the
//   key's older ones; past `max` keys the one used longest ago goes.
export function factsCache(max = CACHE_MAX) {
  const kept = new Map();
  return {
    get(key, refs) {
      const entry = key == null || refs == null ? null : kept.get(key);
      if (!entry || entry.refs !== refs) return null;
      kept.delete(key);
      kept.set(key, entry);
      return entry.facts;
    },
    put(key, refs, facts) {
      if (key == null || refs == null || !facts?.ok) return;
      kept.delete(key);
      kept.set(key, { refs, facts });
      while (kept.size > max) kept.delete(kept.keys().next().value);
    },
    clear() { kept.clear(); },
    size() { return kept.size; },
  };
}

// menuFacts(kept) → { now(), first(facts), done(facts), late() }: what a commit menu's model
//   gets as its facts (log-menus.js ctx: { edit?, editPending? }) while they are read.
//   kept: the facts kept for these commits (factsCache get), or null.
//   now(): the present answer. Each call below returns it, the same object when nothing
//   changed, so the menu redraws only on a change.
//   first(facts): all but the local changes answered (readEditFacts first). Kept facts are
//     whole already and stay.
//   done(facts): the read ended. Facts that were read replace the kept ones where they
//     differ; a failed read keeps the kept ones, else leaves the items to check when picked.
//   late(): FACTS_WAIT passed with the read still going. Nothing waits any more: what is
//     known holds (git status may be all that is left) and the rest checks when picked.
export function menuFacts(kept) {
  let now = kept ? { edit: kept } : { editPending: true }, read = false;
  return {
    now: () => now,
    first(facts) {
      if (!kept && !read && facts) now = { edit: facts, editPending: true };
      return now;
    },
    done(facts) {
      read = true;
      if (facts?.ok ? !sameFacts(kept, facts) : !kept) now = facts?.ok ? { edit: facts } : {};
      return now;
    },
    late() {
      if (!read && now.editPending) now = now.edit ? { edit: now.edit } : {};
      return now;
    },
  };
}

// sameFacts(a, b) → whether `b` shows the menu nothing `a` didn't: equal but for git's own
// words (out, err).
export function sameFacts(a, b) {
  const plain = (f) => (f ? JSON.stringify({ ...f, out: undefined, err: undefined }) : null);
  return plain(a) === plain(b);
}
