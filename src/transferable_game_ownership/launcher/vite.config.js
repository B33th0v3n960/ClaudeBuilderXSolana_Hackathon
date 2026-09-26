import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A fixed port of its own so the launcher runs alongside the store — and so the store can be
// stopped independently to show this page still working. 5173/5174 are left to the store.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
});
