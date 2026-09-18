import type { PhysiquePoint } from "@shared/physique";

/**
 * ~40 lines of inline SVG rather than a charting library.
 *
 * The x axis is `dayOffset`, not the index, so a fortnight of silence LOOKS
 * like a fortnight. Index-spaced points would draw four weigh-ins in January
 * and one in March as an evenly paced line, which is a picture of a trend
 * that never happened.
 */
export function Sparkline({ points, width = 280, height = 44 }: { points: readonly PhysiquePoint[]; width?: number; height?: number }) {
  if (points.length < 2) return null;

  const pad = 4;
  const xs = points.map((p) => p.dayOffset);
  const ys = points.map((p) => p.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const x = (value: number) => pad + ((value - xMin) / xSpan) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - yMin) / ySpan) * (height - pad * 2);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.dayOffset).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Trend">
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p) => (
        <circle key={p.date} cx={x(p.dayOffset)} cy={y(p.value)} r="1.6" fill="var(--primary)" opacity="0.45" />
      ))}
      <circle cx={x(last.dayOffset)} cy={y(last.value)} r="2.8" fill="var(--primary)" />
    </svg>
  );
}
