/**
 * The strip that appears when you have selected more than one thing.
 *
 * Nothing on screen changes until there is a selection, which is the whole
 * reason multi-select could be added to two finished screens without either
 * of them growing a toolbar they do not need. Below two it stays away: one
 * selected item has nothing a bulk action could do that the item's own
 * controls do not already do better.
 *
 * Fixed to the foot of the window rather than pushed into the page. The
 * selection can span a board that scrolls and a week that scrolls
 * independently of it, so a bar in the flow would be somewhere else by the
 * time you wanted it — and a count you have to scroll to find is a count you
 * stop trusting.
 */
export default function SelectionBar({
  count,
  noun = "selected",
  onClear,
  children,
}: {
  count: number;
  /** What the number is counting, when "3 selected" is not specific enough. */
  noun?: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  if (count < 2) return null;

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection actions">
      <span className="selection-count">
        {count} {noun}
      </span>
      <div className="selection-actions">{children}</div>
      {/* Last, and quiet. Escape does the same thing from anywhere; this is
          for the hand already on the mouse. */}
      <button className="btn-quiet selection-clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
