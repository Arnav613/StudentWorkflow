import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

/*
 * Inter, app-wide and eagerly.
 *
 * Geist is the face the app is set in — see index.html — and Inter is now the
 * layer under it: a local font, bundled with the editor package, that renders
 * the first frame while Geist is still in flight and covers the case where
 * the font origin is blocked. It is imported here rather than from NoteEditor
 * because that file lives in the lazy chunk, and the fallback has to be in
 * the first paint to be a fallback at all.
 */
import "@blocknote/core/fonts/inter.css";
import "./index.css";
import { registerServiceWorker } from "./lib/pwa";

// Before render, but the registration itself waits for `load` — see lib/pwa.
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
