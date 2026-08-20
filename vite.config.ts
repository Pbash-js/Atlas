import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves this as a project site (pbash-js.github.io/Atlas/), not from the domain
// root, so every asset path needs the /Atlas/ prefix there. VITE_BASE is set only by the Pages
// workflow — local dev and any other host keep the default root base.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: { port: 5273 },
});
