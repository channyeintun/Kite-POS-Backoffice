import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Two pages, two programs, one source tree.
//
// A role decides which app a sign-in opens and there is no navigation between
// them — so the till and the back office are separate HTML entries with
// separate manifests, and each installs as its own PWA on the device that needs
// it. A counter tablet installs the till and never carries the back office's
// icon; the owner's phone does the opposite.
//
// They share the modules in `src/` — `api.ts`, `money.ts`, `model.ts` — and
// each bundle carries only what its own entry reaches, so the back office's
// vocabulary (`words.ts`) is never on a lane.
export default {
  plugins: [react()],
  server: {
    port: 5173,
    // The Worker runs on 8787 in development. Proxying rather than pointing the
    // app at another origin keeps the development build on the same-origin path
    // the production build does not have — so CORS is exercised in production
    // and never silently depended on here.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        office: resolve(import.meta.dirname, "office.html"),
      },
    },
  },
};
