/**
 * Tab-bar glyphs, and where each assembled surface lives.
 *
 * Inline SVG rather than an icon package: this app has to render with no
 * outbound network (see index.css), and six paths are not worth a dependency
 * or a font file. Routes stay registered whether or not a surface is in the
 * nav — a collapsed surface is still reachable by URL, just not advertised.
 */
export const SURFACE_HREF: Record<string, string> = {
  plan: "/",
  goals: "/goals",
  athlete: "/athlete",
  coach: "/coach",
  data: "/data",
};

const PATHS: Record<string, JSX.Element> = {
  plan: (
    <>
      <rect x="3" y="4.5" width="18" height="16" rx="3" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18" />
      <path d="M8.5 14.5l2.2 2.2 4.2-4.2" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>
  ),
  athlete: (
    <>
      <circle cx="12" cy="6" r="3" />
      <path d="M6.5 21v-3.5a5.5 5.5 0 0 1 11 0V21" />
    </>
  ),
  coach: (
    <>
      <path d="M20.5 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.4-5.3A7.5 7.5 0 1 1 20.5 12.5Z" />
    </>
  ),
  data: (
    <>
      <path d="M4 19.5V13M9.3 19.5V7.5M14.7 19.5v-8M20 19.5V4.5" />
    </>
  ),
  app: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" strokeDasharray="2.4 2.4" />
    </>
  ),
};

export function NavIcon({ id }: { id: string }) {
  const paths = PATHS[id] ?? PATHS.app;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths}
    </svg>
  );
}
