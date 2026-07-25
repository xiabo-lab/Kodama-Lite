import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Single source of truth for the version the settings menu shows: read it
// from package.json at build time rather than hard-coding a second copy
// that would silently drift on the next release bump.
const { version } = JSON.parse(
  readFileSync(path.resolve(__dirname, "./package.json"), "utf8"),
) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Tauri watches the Rust side itself; ignore it here.
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
