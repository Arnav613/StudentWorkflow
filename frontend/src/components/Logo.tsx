/**
 * The app mark.
 *
 * An inline SVG rather than the CSS gradient square it replaces: that was a
 * placeholder shape with no idea in it, and at 22px a plain rounded rectangle
 * reads as a missing image. This is three stacked cards with the top one
 * ticked — the app's whole subject in one glyph.
 *
 * One flat ink square, not the indigo-to-pink gradient it carried before. A
 * three-hue gradient in a 22px mark resolves to a muddy purple smear at the
 * size it is actually seen, and it was the only place in the app still using
 * hues that appear nowhere else in the palette.
 */
export default function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="7" className="logo-plate" />

      {/* The two cards behind, at reduced opacity — depth without a second
          colour to keep in step. */}
      <rect x="9" y="6.5" width="14" height="3" rx="1.5" className="logo-ink" opacity="0.35" />
      <rect x="7" y="12" width="18" height="3" rx="1.5" className="logo-ink" opacity="0.6" />

      {/* The tick. Round caps so it stays legible when the mark is scaled to
          a 16px favicon. */}
      <path
        d="M10 21.5l3.6 3.6L23 16"
        className="logo-stroke"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
