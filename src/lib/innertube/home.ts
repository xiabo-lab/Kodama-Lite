// Ported verbatim from YTMLite's src/lib/innertube/home.ts.

import type { Shelf } from "./types";
import {
  collectShelfNodes,
  mapShelfWrapper,
  rawBrowse,
  rawBrowseContinuation,
  type YtNode,
} from "./shared";

export type HomeFeedPage = {
  shelves: Shelf[];
  nextCursor?: string;
};

// djb2 hash → short base36 tag. Continuation tokens share a long leading
// prefix, so `cursor.slice(0, 12)` collided across pages and produced
// duplicate React keys for header-less/repeated-title shelves; hashing the
// whole token gives a stable, page-unique tag instead.
function hashToken(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export async function fetchHomeFeedPage(
  cursor?: string,
): Promise<HomeFeedPage> {
  const json = cursor
    ? await rawBrowseContinuation(cursor)
    : await rawBrowse("FEmusic_home");

  const { sections, nextCursor } = cursor
    ? extractContinuationPage(json)
    : extractInitialPage(json);

  const shelfNodes = collectShelfNodes(sections);

  const cursorTag = cursor ? hashToken(cursor) : "init";
  // Track titles per page so duplicate-titled shelves get a stable
  // unique suffix instead of leaking the index into the id.
  const titleSeen = new Map<string, number>();
  const shelves: Shelf[] = [];
  shelfNodes.forEach((wrapper, i) => {
    const { title, items, display } = mapShelfWrapper(wrapper, i);
    if (items.length === 0) return;
    const seen = titleSeen.get(title) ?? 0;
    titleSeen.set(title, seen + 1);
    const suffix = seen === 0 ? "" : `-${seen}`;
    shelves.push({
      id: `${cursorTag}-${title}${suffix}`,
      title,
      items,
      display,
    });
  });

  return { shelves, nextCursor };
}

function extractInitialPage(json: YtNode): {
  sections: YtNode[];
  nextCursor?: string;
} {
  const tabs: YtNode[] =
    json?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const sectionList = tabs[0]?.tabRenderer?.content?.sectionListRenderer;
  const sections: YtNode[] = sectionList?.contents ?? [];
  const nextCursor =
    findContinuationInContents(sections) ??
    findContinuationInList(sectionList?.continuations);
  return { sections, nextCursor };
}

function extractContinuationPage(json: YtNode): {
  sections: YtNode[];
  nextCursor?: string;
} {
  // Modern shape: onResponseReceivedActions[*].appendContinuationItemsAction
  let sections: YtNode[] = [];
  const actions: YtNode[] = json?.onResponseReceivedActions ?? [];
  for (const a of actions) {
    const items = a?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(items)) sections = sections.concat(items);
  }

  // Legacy shape: continuationContents.sectionListContinuation
  const legacy = json?.continuationContents?.sectionListContinuation;
  if (sections.length === 0 && Array.isArray(legacy?.contents)) {
    sections = legacy.contents;
  }

  const nextCursor =
    findContinuationInContents(sections) ??
    findContinuationInList(legacy?.continuations);
  return { sections, nextCursor };
}

function findContinuationInContents(contents: YtNode[]): string | undefined {
  for (const c of contents) {
    const t =
      c?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;
    if (t) return t;
  }
  return undefined;
}

function findContinuationInList(list?: YtNode[]): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const c of list) {
    const t = c?.nextContinuationData?.continuation;
    if (t) return t;
  }
  return undefined;
}
