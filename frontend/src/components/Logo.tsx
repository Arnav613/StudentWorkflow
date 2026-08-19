/**
 * The app mark.
 *
 * An inline SVG rather than the CSS gradient square it replaces: that was a
 * placeholder shape with no idea in it, and at 22px a plain rounded rectangle
 * reads as a missing image. This is three stacked cards with the top one
 * ticked — the app's whole subject in one glyph.
 *
 * The gradient needs a document-unique id. Two of these on one page with the
 * same id would both resolve to whichever was parsed first, which is a real
 * bug the moment the mark appears in a header and an empty state at once.
 */
let seq = 0;

export default function Logo({ size = 22 }: { size?: number }) {
  const id = `logo-grad-${(seq += 1)}`;

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
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="0.55" stopColor="#A855F7" />
          <stop offset="1" stopColor="#EC4899" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />

      {/* The two cards behind, at reduced opacity — depth without a second
          colour to keep in step with the gradient. */}
      <rect x="9" y="6.5" width="14" height="3" rx="1.5" fill="#fff" opacity="0.45" />
      <rect x="7" y="12" width="18" height="3" rx="1.5" fill="#fff" opacity="0.7" />

      {/* The tick. Round caps so it stays legible when the mark is scaled to
          a 16px favicon. */}
      <path
        d="M10 21.5l3.6 3.6L23 16"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
