// One git write at a time per repository, whichever copy of the mod starts it (Commit
// panel, Log panel, a tab on the same repository). ui.js keeps the value in Herdr's
// shared state; this file only works on it, so node can test it. No `herdr` import.
//
// value: { [key]: { owner, label, work?, beat } }. key: the machine and root (lockKey).
// owner: the holding copy's id (bus.js). label: what runs, in the holder's language
// ("Committing…"). work: the same as a message key and its values ({ key: "commit.committing",
// args: {} }), which a copy words in its own language; a record without it (written by a
// copy of the mod that only writes the label) is shown by its label. beat: when the
// holder last said it is alive, in ms.

// The holder writes its beat this often while it holds a lock (most writes end sooner
// and never beat). A record not beaten for longer than STALE is dead: its copy went
// without closing (a crash), and anyone may take the repository.
export const BEAT = 5000;
export const STALE = 15000;

export const lockKey = ({ on = null, root } = {}) => JSON.stringify([on ?? null, root ?? null]);

// Whether two { root, on } name one repository: the one a write started on and the one a
// panel shows now may differ, since a panel follows the focused pane while it writes.
// A missing side (no repository, no root) is never the same as anything.
export const sameRepo = (a, b) => Boolean(a?.root && b?.root) && lockKey(a) === lockKey(b);

// The repository's folder name (the root's last part), put before a failure that comes
// from a repository the panel no longer shows.
export function repoName(root) {
  const parts = String(root ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(root ?? "");
}

// The value is the person's saved shared state: nothing yet, or edited by hand. A record
// that isn't well formed counts as no record. One whose beat lies ahead by more than
// STALE (the clock was set back) would otherwise hold the repository for that long.
function wellFormed(record) {
  if (!record || typeof record !== "object") return false;
  const { owner, label, beat } = record;
  return typeof owner === "string" && typeof label === "string" && Number.isFinite(beat);
}
function alive(record, now) {
  return wellFormed(record) && now - record.beat <= STALE && record.beat - now <= STALE;
}

// A record's work when it is well formed ({ key: string, args: object }), else null.
function workOf(record) {
  const work = record?.work;
  if (!work || typeof work !== "object" || typeof work.key !== "string") return null;
  if (work.args !== undefined && (!work.args || typeof work.args !== "object" || Array.isArray(work.args))) return null;
  return { key: work.key, args: work.args ?? {} };
}
// What a record tells about the write it holds: { label, work? }.
function told(record) {
  const work = workOf(record);
  return work ? { label: record.label, work } : { label: record.label };
}

const records = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// The live records only: what a write leaves behind, so dead ones never pile up.
function live(value, now) {
  const out = {};
  for (const [key, record] of Object.entries(records(value))) if (alive(record, now)) out[key] = record;
  return out;
}

// makeLocks(io, owner, now) → one copy's side of the locks. main.js makes one per copy
// (with the bus's id as `owner`); the modules may be shared by every copy, so nothing a
// copy holds is kept at module level.
//   io: { read() → value, write(value) }: the shared-state slot.
//   now(): the time in ms (Date.now in the app; the test's own clock in node).
//
//   take(repo, label, work?) → { ok: true } | { ok: false, label, work? }: reads and
//                       writes in this one call. Refused while any live record holds the
//                       repository, this copy's own included: one write at a time.
//                       work: { key, args? } (see value above).
//   holder(repo)      → { label, work?, mine } | null: the live record on the repository
//   release(repo)       this copy's record on it goes; anyone else's stays
//   releaseAll()        every record this copy holds goes (the copy is closing)
//   beat()              this copy's records are marked alive now; writes nothing when
//                       it holds none (every write redraws every copy)
export function makeLocks(io, owner, now) {
  const mineIn = (value) => Object.entries(records(value)).filter(([, r]) => r?.owner === owner);

  return {
    take(repo, label, work = null) {
      const t = now(), value = live(io.read(), t), key = lockKey(repo);
      if (value[key]) return { ok: false, ...told(value[key]) };
      const what = workOf({ work });
      io.write({ ...value, [key]: { owner, label: String(label), ...(what ? { work: what } : {}), beat: t } });
      return { ok: true };
    },
    holder(repo) {
      const record = records(io.read())[lockKey(repo)];
      return alive(record, now()) ? { ...told(record), mine: record.owner === owner } : null;
    },
    release(repo) {
      const value = records(io.read()), key = lockKey(repo);
      if (value[key]?.owner !== owner) return;
      const { [key]: _gone, ...rest } = value;
      io.write(rest);
    },
    releaseAll() {
      const value = records(io.read());
      if (!mineIn(value).length) return;
      io.write(Object.fromEntries(Object.entries(value).filter(([, r]) => r?.owner !== owner)));
    },
    // A record not beaten for longer than STALE isn't renewed: a copy that was stalled
    // that long has lost its lock to whoever may have taken the repository since, and
    // doesn't get it back. One that lies ahead is: the holder is alive and the clock was
    // set back. Until this beat others see it as dead, so for up to BEAT after the clock
    // jumps back by more than STALE another copy can take the repository (git's own lock
    // still refuses a second write that overlaps).
    beat() {
      const t = now(), value = records(io.read());
      const mine = mineIn(value).filter(([, r]) => wellFormed(r) && t - r.beat <= STALE);
      if (!mine.length) return;
      const next = { ...value };
      for (const [key, r] of mine) next[key] = { ...r, beat: t };
      io.write(next);
    },
  };
}
