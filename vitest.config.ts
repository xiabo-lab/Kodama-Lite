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
  // Mirrors vite.config.ts's define so anything a test transitively imports
  // doesn't blow up on an undeclared global. Not read from package.json
  // here — no test asserts on the value, only on it existing.
  define: {
    __APP_VERSION__: JSON.stringify("test"),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
