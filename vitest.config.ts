import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone vitest config (kept separate from vite.config.ts so the
// heavier react/tailwind plugins don't run for unit tests). Tests target
// pure store logic that doesn't touch the DOM or Tauri, so a plain node
// environment is enough.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
