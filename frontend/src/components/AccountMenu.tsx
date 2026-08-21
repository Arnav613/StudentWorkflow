import { useEffect, useRef, useState } from "react";
import { signOut } from "../lib/supabase";
import NotificationToggle from "./NotificationToggle";

/**
 * The account control: an initial, and a menu behind it.
 *
 * Replaces a raw email address next to a filled Sign out button — which made
 * the most visually prominent thing in the top bar the action you want least
 * often, and spent 250px of every screen restating an address the user is not
 * confused about on their own laptop. The address is still there, one click
 * away, because "which account am I in" is a real question when a university
 * hands out two.
 */
export default function AccountMenu({
  email,
  pushEnabled,
}: {
  email: string;
  /** Server-side readiness. False renders no reminders control at all. */
  pushEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Click-away and Escape. A menu that can only be closed by picking
  // something from it is a menu that has taken the page hostage.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = (email.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="account" ref={wrap}>
      <button
        className="avatar"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${email}`}
        title={email}
      >
        {initial}
      </button>

      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="menu-label">Signed in as</span>
            <span className="menu-email">{email}</span>
          </div>
          {pushEnabled && <NotificationToggle />}
          <button className="menu-item" role="menuitem" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
