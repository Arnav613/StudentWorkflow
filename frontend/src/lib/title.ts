import { useEffect } from "react";

const SUFFIX = "Student Dashboard";

/**
 * The browser tab, told where you are.
 *
 * Every screen used to say "Student Dashboard", which is useless in the one
 * situation a title exists for: eleven tabs open, and you are looking for the
 * one with your Machine Learning notes in it. Specific part first, because
 * that is the half a narrow tab still shows.
 *
 * Written straight to document.title rather than through a head-management
 * library — there is one title, one writer per render, and nothing else on
 * the page competes for it.
 */
export function useTitle(parts: Array<string | null | undefined>) {
  // Joined here so the effect depends on the string, not on a fresh array
  // identity every render.
  const title = [...parts.filter(Boolean), SUFFIX].join(" · ");

  useEffect(() => {
    document.title = title;
  }, [title]);
}
