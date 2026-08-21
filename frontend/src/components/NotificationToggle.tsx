import { useEffect, useState } from "react";
import { currentState, disable, enable, sendTest, type PushState } from "../lib/push";
import { errorText, toast } from "../lib/toast";

/**
 * Reminders, as one row inside the account menu.
 *
 * It lives here rather than in a settings screen because it is a single
 * switch, and a screen with one switch on it is a screen nobody finds. The
 * menu is where "things about me and this device" already are.
 *
 * The states it can be in are not decorative. Notification permission is
 * asked for once per browser and a refusal is close to permanent, so this
 * distinguishes "off" from "blocked" and says something different for each —
 * offering a button that cannot work is how a person concludes the app is
 * broken when it is their own earlier answer stopping them.
 */
export default function NotificationToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    currentState()
      .then((s) => live && setState(s))
      .catch(() => live && setState({ kind: "unsupported" }));
    return () => {
      live = false;
    };
  }, []);

  // Still asking the service worker. A flash of "Reminders off" that becomes
  // "on" a moment later reads as the setting having been forgotten.
  if (!state) return null;

  if (state.kind === "unsupported") return null;

  if (state.kind === "needs-install") {
    return (
      <div className="menu-note">
        <span className="menu-label">Reminders</span>
        {/* The exact gesture, because iOS hides it and there is no other way
            in: Safari gives an installed PWA notifications and a tab none. */}
        <p className="muted small">
          Tap Share, then <strong>Add to Home Screen</strong>, and open it from
          there to turn on morning reminders.
        </p>
      </div>
    );
  }

  if (state.kind === "blocked") {
    return (
      <div className="menu-note">
        <span className="menu-label">Reminders</span>
        <p className="muted small">
          Notifications are blocked for this site. The browser will not ask
          again — turn them back on in its site settings.
        </p>
      </div>
    );
  }

  const on = state.kind === "on";

  return (
    <div className="menu-note">
      <button
        className="menu-item"
        role="menuitem"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setState(on ? await disable() : await enable());
            if (!on) toast("Reminders on — a digest each morning at 8", "success");
          } catch (e) {
            // Safari throws from requestPermission when it is unhappy rather
            // than returning a verdict, so this path is reachable in normal
            // use and the message is worth showing verbatim.
            toast(errorText(e, "Could not change reminders"), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : on ? "Turn off reminders" : "Turn on reminders"}
      </button>

      {on && (
        <button
          className="menu-item subtle"
          role="menuitem"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await sendTest();
              // A test that sends nothing is the correct outcome on a quiet
              // day — the digest stays silent when nothing is due — and
              // saying so is the difference between that and a broken setup.
              toast(
                r.sent > 0
                  ? "Sent — check your notifications"
                  : "Nothing due today, so nothing to send. That is what a quiet morning looks like.",
                r.sent > 0 ? "success" : "info",
              );
            } catch (e) {
              toast(errorText(e, "Could not send a test"), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          Send one now
        </button>
      )}
    </div>
  );
}
