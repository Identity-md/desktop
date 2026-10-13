import { defineConfig } from "vite";

// Tauri expects a fixed dev port and esnext output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1430, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "esnext" },
});
