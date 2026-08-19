import { useEffect, useRef, useState } from "react";
import type { Class } from "../lib/types";

/**
 * Pick a class, with the colours the rest of the app identifies classes by.
 *
 * A native `<select>` cannot draw anything inside its own list — the open
 * popup is an OS window, and `option` takes a font and a background colour and
 * nothing else. So the one field where you choose a class was the one place a
 * class appeared as bare text, while every other surface in the app teaches
 * you to find it by colour first and read the name second.
 *
 * Same shape as DatePicker on purpose: a trigger that matches an input, a
 * popover under it, Escape and click-outside. Two hand-rolled popovers in one
 * form would be worth a shared primitive; two that behave differently would
 * be worse than either.
 */
export default function ClassPicker({
  classes,
  value,
  onChange,
}: {
  classes: Class[];
  /** A class id, or "" for no class. */
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const selected = classes.find((c) => c.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening moves focus into the list, so the arrow keys a select-shaped
  // control is expected to answer land somewhere that handles them.
  useEffect(() => {
    if (!open) return;
    const options = list.current?.querySelectorAll<HTMLButtonElement>("[role=option]");
    (
      list.current?.querySelector<HTMLButtonElement>("[aria-selected=true]") ??
      options?.[0]
    )?.focus();
  }, [open]);

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const options = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [],
    );
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    // Wraps at both ends: a six-item list is a ring, and stopping dead at the
    // bottom of one is a rule nobody asked for.
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="picker" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className={`picker-trigger${selected ? "" : " empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`picker-dot${selected ? ` hue-${selected.color}` : " hue-none"}`} aria-hidden="true" />
        <span className="grow ellipsis">{selected ? selected.name : "No class"}</span>
        <span className="picker-caret" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="picker-pop picker-list"
          role="listbox"
          aria-label="Class"
          ref={list}
          onKeyDown={onListKeyDown}
        >
          <Option
            label="No class"
            selected={!selected}
            onClick={() => choose("")}
          />
          {classes.map((c) => (
            <Option
              key={c.id}
              label={c.name}
              hue={c.color}
              selected={c.id === value}
              onClick={() => choose(c.id)}
            />
          ))}
          {/* A picker with nothing to pick should say why rather than open an
              empty box. */}
          {classes.length === 0 && (
            <p className="muted small picker-empty">
              No classes yet — a task without one is fine.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hue,
  selected,
  onClick,
}: {
  label: string;
  hue?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`picker-option${selected ? " selected" : ""}`}
      onClick={onClick}
    >
      <span className={`picker-dot${hue ? ` hue-${hue}` : " hue-none"}`} aria-hidden="true" />
      <span className="grow ellipsis">{label}</span>
    </button>
  );
}
