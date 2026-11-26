// Finding the repository a folder belongs to, asked through the git runner a screen hands in.

import { ASK_IN_C, outsideRepo } from "./git-port.js";

// The repository a folder belongs to: { ok: true, root }, or { ok: false, notRepo, err }.
// notRepo tells "this folder isn't in a repository" (show the notice) from "git could not
// be asked" (show the error and try again later).
export async function repoRoot(git, folder) {
  const r = await git.read(folder, ["rev-parse", "--show-toplevel"], { env: ASK_IN_C });
  const root = r.out.trim();
  if (r.ok && root) return { ok: true, root };
  return { ok: false, notRepo: outsideRepo(r), err: r.err };
}
