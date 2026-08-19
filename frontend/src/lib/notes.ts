/**
 * Notes: one notebook per class, many notes inside it.
 *
 * Straight from the browser to Supabase, for the same reason as db.ts — but
 * more so. Typing is the whole interaction here, autosave fires every couple
 * of seconds, and routing that through a Render dyno that sleeps would put a
 * cold start between a keystroke and the word "Saved". Sync is the only thing
 * that needs a server; notes never touch one.
 */

import { supabase } from "./supabase";
import type { Note } from "./types";

const BUCKET = "note-images";

function unwrap<T>({ data, error }: { data: T | null; error: unknown }): T {
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The notebook list for one class.
 *
 * Content is left out on purpose: a semester of notes is megabytes of block
 * trees, and the sidebar needs a title and a date. The document is fetched
 * only when a note is actually opened.
 */
export async function listNotes(
  classId: string,
): Promise<Array<Pick<Note, "id" | "class_id" | "title" | "updated_at">>> {
  return unwrap(
    await supabase
      .from("notes")
      .select("id, class_id, title, updated_at")
      .eq("class_id", classId)
      .order("updated_at", { ascending: false }),
  );
}

export async function getNote(id: string): Promise<Note> {
  return unwrap(await supabase.from("notes").select("*").eq("id", id).single());
}

export async function createNote(input: {
  user_id: string;
  class_id: string;
  title?: string;
}): Promise<Note> {
  return unwrap(await supabase.from("notes").insert(input).select().single());
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, "title" | "content">>,
): Promise<Note> {
  return unwrap(
    await supabase.from("notes").update(patch).eq("id", id).select().single(),
  );
}

/**
 * Delete a note, and the images that only it referenced.
 *
 * Images go first and failing to remove them is not fatal. An orphaned image
 * costs a few hundred kilobytes of a free gigabyte; a note that refuses to
 * delete because Storage was briefly unhappy costs trust. The row is the
 * thing the user asked to be rid of.
 */
export async function deleteNote(note: Pick<Note, "id" | "user_id">): Promise<void> {
  try {
    await deleteNoteImages(note.user_id, note.id);
  } catch {
    // Best effort, by design. See above.
  }
  const { error } = await supabase.from("notes").delete().eq("id", note.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Images
//
// The bucket is private, so a note stores an object *path* and the browser
// signs a URL to render it. Paths are `<user_id>/<note_id>/<random>.<ext>`:
// the first segment is what the storage policy checks, the second is what
// makes deleting a note able to take its images with it.
// ---------------------------------------------------------------------------

function extensionOf(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : "";
  if (fromName && /^[a-z0-9]{1,5}$/i.test(fromName)) return fromName.toLowerCase();
  // A pasted screenshot has no filename at all.
  const fromType = file.type.split("/")[1];
  return fromType === "jpeg" ? "jpg" : fromType || "bin";
}

export async function uploadNoteImage(
  userId: string,
  noteId: string,
  file: File,
): Promise<string> {
  const path = `${userId}/${noteId}/${crypto.randomUUID()}.${extensionOf(file)}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

/**
 * Sign a URL for one stored image.
 *
 * Signed URLs are cached until shortly before they expire, because the editor
 * asks for the same one on every re-render and a network round trip per
 * keystroke would make a note with three images unusable.
 *
 * Anything that already looks like a URL is handed back untouched: pasting an
 * image address from the web is a perfectly good way to put a picture in a
 * note, and it never went through this bucket.
 */
const SIGNED_TTL_SECONDS = 3600;
const signedCache = new Map<string, { url: string; expiresAt: number }>();

export async function resolveNoteImage(pathOrUrl: string): Promise<string> {
  if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) return pathOrUrl;

  const hit = signedCache.get(pathOrUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.url;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(pathOrUrl, SIGNED_TTL_SECONDS);
  if (error || !data) throw error ?? new Error("Could not load image");

  signedCache.set(pathOrUrl, {
    url: data.signedUrl,
    // A minute of headroom, so a URL is never handed out as it expires.
    expiresAt: Date.now() + (SIGNED_TTL_SECONDS - 60) * 1000,
  });
  return data.signedUrl;
}

async function deleteNoteImages(userId: string, noteId: string): Promise<void> {
  const prefix = `${userId}/${noteId}`;
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix);
  if (error) throw error;
  if (!data?.length) return;
  const { error: removeError } = await supabase.storage
    .from(BUCKET)
    .remove(data.map((f) => `${prefix}/${f.name}`));
  if (removeError) throw removeError;
}

/**
 * How many notes each class has, for the class cards.
 *
 * Ids only, counted in the browser. The alternative is one `head: true` count
 * request per class, which turns a four-class semester into four round trips
 * to render one grid. A note id is 36 bytes and nobody has enough notes for
 * that to matter before the query itself does.
 */
export async function countNotesByClass(): Promise<Record<string, number>> {
  const rows = unwrap(
    await supabase.from("notes").select("class_id"),
  ) as Array<{ class_id: string }>;

  const out: Record<string, number> = {};
  for (const r of rows) out[r.class_id] = (out[r.class_id] ?? 0) + 1;
  return out;
}
