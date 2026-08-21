import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "../lib/db";
import type { ClassDocument, DocumentKind } from "../lib/types";
import { toast, undoable } from "../lib/toast";
import { extractDocument, type Extraction } from "../lib/api";

function message(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

/** 15 MB, the same number the bucket enforces — said before the upload rather
 * than after it, because a rejection that arrives at the end of a slow upload
 * on college wifi is a minute of somebody's day spent on nothing. */
const MAX_BYTES = 15 * 1024 * 1024;

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/heic";

/**
 * Upload a handout, keep it, and ask what it says.
 *
 * One component for both kinds of document, because everything either side of
 * the model is identical: the same bucket, the same row, the same button, the
 * same waiting. Only the schema that comes back differs, and that is the
 * caller's problem — this hands over the `Extraction` and steps out of the
 * way.
 *
 * The file is kept after it has been read. Extraction is editable and will be
 * edited, and "what did the handout actually say?" has to stay answerable, so
 * the document list below is not a queue of things waiting to be processed —
 * it is the shelf they sit on afterwards.
 */
export default function DocumentUpload({
  classId,
  userId,
  kind,
  aiEnabled,
  busy,
  onExtracted,
}: {
  classId: string;
  userId: string;
  kind: DocumentKind;
  aiEnabled: boolean;
  /** True while the caller's review table is open, so a second Extract cannot
   * quietly replace rows somebody is halfway through correcting. */
  busy: boolean;
  onExtracted: (doc: ClassDocument, result: Extraction) => void;
}) {
  const [docs, setDocs] = useState<ClassDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDocs(await db.listClassDocuments(classId, kind));
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setLoading(false);
    }
  }, [classId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function read(doc: ClassDocument) {
    setReading(doc.id);
    try {
      const result = await extractDocument(doc.id);
      if (result.note) toast(result.note, "info");
      onExtracted(doc, result);
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setReading(null);
    }
  }

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      toast("That file is larger than 15 MB", "error");
      return;
    }
    setUploading(true);
    try {
      const doc = await db.uploadClassDocument({
        user_id: userId,
        class_id: classId,
        kind,
        file,
      });
      setDocs((prev) => [doc, ...prev]);
      // Straight on to reading it. Uploading a timetable and then being asked
      // to press a second button to find out what is in it would be the app
      // making somebody confirm the thing they just did.
      if (aiEnabled) await read(doc);
    } catch (e) {
      toast(message(e), "error");
    } finally {
      setUploading(false);
      // Cleared so that re-picking the same file fires a change event at all.
      if (input.current) input.current.value = "";
    }
  }

  async function open(doc: ClassDocument) {
    try {
      const url = await db.signClassDocument(doc.storage_path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast(message(e), "error");
    }
  }

  function remove(doc: ClassDocument) {
    const previous = docs;
    undoable({
      // Said in full, because the thing that is *not* happening is the
      // surprising part: the schedule or the rubric this produced stays.
      message: `Removed ${doc.title}. What it produced is kept.`,
      apply: () => setDocs((prev) => prev.filter((d) => d.id !== doc.id)),
      commit: () => db.deleteClassDocument(doc),
      revert: () => setDocs(previous),
    });
  }

  const label = kind === "timetable" ? "timetable" : "rubric";

  return (
    <section className="panel">
      <h2>Upload a {label}</h2>
      <p className="muted small">
        PDF or photo, up to 15 MB.{" "}
        {!aiEnabled && "Reading it needs AI, which is off on this deployment."}
      </p>

      <div className="doc-row">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          disabled={uploading || busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {uploading && <span className="muted small">Uploading…</span>}
        {reading && <span className="muted small">Reading the document…</span>}
      </div>

      {loading ? (
        <p className="muted small">Loading…</p>
      ) : docs.length > 0 ? (
        <ul className="list docs-list">
          {docs.map((d) => (
            <li key={d.id}>
              <span className="doc-icon" aria-hidden="true">
                ▤
              </span>
              <button className="link grow doc-link" onClick={() => void open(d)}>
                <span className="doc-title">{d.title}</span>
              </button>
              <span className="doc-actions">
                {aiEnabled && (
                  <button
                    className="link"
                    onClick={() => void read(d)}
                    disabled={reading === d.id || busy}
                  >
                    {reading === d.id ? "Reading…" : "Re-extract"}
                  </button>
                )}
                <button
                  className="link danger icon-btn"
                  onClick={() => remove(d)}
                  aria-label={`Remove ${d.title}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
