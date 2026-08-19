import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

/*
 * Inter, app-wide and eagerly.
 *
 * It ships with the editor package, so this is a local font with no webfont
 * request and no third-party origin. It used to be imported from NoteEditor,
 * which lives in the lazy chunk — meaning every screen except an open note
 * rendered in the system stack and the whole app visibly changed typeface the
 * first time someone opened their notes.
 */
import "@blocknote/core/fonts/inter.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
