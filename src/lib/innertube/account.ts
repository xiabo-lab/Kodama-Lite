import { innertubePost, readRuns, readThumbnails, type YtNode } from "./shared";

/**
 * Who is signed in — the name and avatar the sidebar button shows once the
 * cookie jar has a session. Comes from InnerTube's `account/account_menu`,
 * the same endpoint the real client's avatar menu uses.
 *
 * Purely cosmetic: nothing about playback, search or the library depends on
 * this call succeeding. It's fired once per sign-in and its failure is
 * swallowed by design (see `fetchAccount`) — being signed in but showing a
 * generic label is a much better outcome than a sign-in that reports itself
 * as failed because an avatar didn't load.
 */
export interface Account {
  name?: string;
  avatar?: string;
}

/**
 * Find `activeAccountHeaderRenderer` anywhere in the response rather than
 * walking the documented path
 * (`actions[0].openPopupAction.popup.multiPageMenuRenderer.header…`).
 * That path has moved more than once across client versions, and there is
 * exactly one such node in the payload, so the walk is unambiguous.
 */
function findAccountHeader(root: unknown): YtNode | null {
  const seen = new WeakSet<object>();
  let found: YtNode | null = null;
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const n = node as YtNode;
    if (n.activeAccountHeaderRenderer) {
      found = n.activeAccountHeaderRenderer as YtNode;
      return;
    }
    for (const key of Object.keys(n)) walk(n[key]);
  };
  walk(root);
  return found;
}

/**
 * Fetch the signed-in account's display name and avatar. Resolves to `null`
 * rather than throwing on any failure — see the module comment.
 */
export async function fetchAccount(): Promise<Account | null> {
  try {
    const response = await innertubePost("account/account_menu", {});
    const header = findAccountHeader(response);
    if (!header) return null;

    const name = readRuns(header.accountName);
    const thumbnails = readThumbnails(header.accountPhoto);
    // Smallest thumbnail that's still sharp at the 20px the button renders
    // it at — the list is ascending, so the first is usually 48px.
    const avatar = thumbnails[0]?.url;

    if (!name && !avatar) return null;
    return { name: name || undefined, avatar };
  } catch {
    return null;
  }
}
