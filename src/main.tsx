import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/index.css";

// Debug-only store exposure, gated behind an explicit query param so it
// never ships as a normal-user affordance. Verification tool for manual/
// automated testing (inspecting store state directly beats scraping the
// DOM), not a runtime feature.
if (new URLSearchParams(location.search).has("debug")) {
  void import("@/store/appStore").then((m) => {
    (window as unknown as Record<string, unknown>).__klAppStore = m.useAppStore;
  });
  void import("@/store/playbackStore").then((m) => {
    (window as unknown as Record<string, unknown>).__klPlaybackStore = m.usePlaybackStore;
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
