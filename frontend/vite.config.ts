import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // One .env for the whole project, at the repo root rather than in here.
  // Only VITE_-prefixed vars from it reach the browser bundle; the backend
  // secrets sharing the file are never exposed.
  envDir: "..",
  server: { port: 5173 },
});
