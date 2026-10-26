import React from "react";
import ReactDOM from "react-dom/client";
import "../src/index.css";
import { ShelfCarousel } from "../src/components/shared/shelf-carousel";
import type { Shelf } from "../src/lib/innertube/types";
import { usePlaybackStore } from "../src/store/playbackStore";

const shelf: Shelf = {
  id: "touch-target-preview",
  title: "Quick picks",
  display: "card",
  items: [
    ["preview0001", "打雀英雄傳", "許冠傑", "#394867"],
    ["preview0002", "Blaze Away", "TRAX", "#64403d"],
    ["preview0003", "Forever Memories", "w-inds.", "#31564f"],
    ["preview0004", "Because of You", "Ne-Yo", "#55416f"],
    ["preview0005", "How Crazy", "YUI", "#6b5337"],
    ["preview0006", "一念之间", "陶喆", "#3b5069"],
  ].map(([id, title, subtitle, tint]) => ({
    kind: "song" as const,
    id,
    title,
    subtitle,
    duration: 220,
    thumbnails: [
      {
        // SVG data URLs keep the harness local while still exercising the
        // real Thumbnail/image/card stack.
        url: `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${tint}"/><circle cx="128" cy="128" r="66" fill="none" stroke="white" stroke-opacity=".32" stroke-width="10"/><circle cx="128" cy="128" r="14" fill="white" fill-opacity=".55"/></svg>`,
        )}`,
        width: 256,
        height: 256,
      },
    ],
  })),
};

function SelectionStatus() {
  const title = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.title : undefined,
  );
  return (
    <output
      aria-live="polite"
      className="absolute right-6 top-2 text-sm text-muted-foreground"
    >
      Selected: {title ?? "nothing"}
    </output>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <main className="h-[440px] w-[1920px] overflow-hidden bg-background p-6 text-foreground">
      <SelectionStatus />
      <ShelfCarousel shelf={shelf} />
    </main>
  </React.StrictMode>,
);
