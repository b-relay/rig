"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  peakOf,
  roundedTop,
  stacked,
  timeLabel,
  type ChartMarker,
  type ChartReport,
} from "@/lib/usage";
import { cn } from "@/lib/utils";

export type { ChartMarker };

/** One layer of a chart: a series' values of one measure. */
export interface ChartLayer {
  readonly key: string;
  readonly label: string;
  /** A CSS colour, normally a chart token such as `var(--chart-3)`. */
  readonly color: string;
  readonly average: readonly (number | null)[];
  readonly high: readonly (number | null)[];
}

const TONE = {
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
} as const;
const PAD = { top: 22, right: 6, bottom: 18, left: 40 } as const;

/** A usage chart: one measure over a range, its layers stacked when there are several. Each layer's peak is flagged
 * where it happened; a single layer also gets its median as a dashed line. Markers stand on the time axis. Pointing at
 * the chart, or tapping it on a phone, shows that moment's values; a second tap, or leaving it, hides them. */
export function UsageChart({
  report,
  layers,
  format,
  floor,
  height = 140,
  median,
  markers = [],
  axis = true,
  className,
}: {
  report: Pick<ChartReport, "from" | "step" | "range">;
  layers: readonly ChartLayer[];
  format: (value: number) => string;
  /** The lowest top the scale may have, so an idle chart is not a scale of noise. */
  floor: number;
  height?: number;
  /** The single layer's median over the range, drawn as a dashed line. */
  median?: number;
  markers?: readonly ChartMarker[];
  /** The scale's numbers and the times under the chart; a small chart leaves them out. */
  axis?: boolean;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [inspected, setInspected] = useState<number | undefined>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry!.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = layers[0]?.average.length ?? 0;
  const pad = axis ? PAD : { ...PAD, left: 2, bottom: 2 };
  const plotWidth = Math.max(width - pad.left - pad.right, 1);
  const plotHeight = height - pad.top - pad.bottom;
  const tops = stacked(layers.map((layer) => layer.average));
  const peaks = layers.map((layer) => peakOf(layer.high));
  const highest = Math.max(
    0,
    ...tops.flatMap((layer) => layer.map((value) => value ?? 0)),
    ...peaks.map((peak) => peak?.value ?? 0),
  );
  const top = roundedTop(highest * 1.1, floor);
  const x = (index: number) =>
    pad.left + (count < 2 ? 0 : (index * plotWidth) / (count - 1));
  const y = (value: number) =>
    pad.top + plotHeight - (value / top) * plotHeight;
  const end = report.from + count * report.step;
  const atX = (at: number) =>
    pad.left +
    ((at - report.from) / Math.max(end - report.from, 1)) * plotWidth;

  const inspect = (event: PointerEvent<HTMLDivElement>, toggle: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.round(
      ((event.clientX - box.left - pad.left) / plotWidth) * (count - 1),
    );
    const clamped = Math.min(count - 1, Math.max(0, index));
    setInspected((current) =>
      toggle && current === clamped ? undefined : clamped,
    );
  };

  return (
    <div
      ref={frame}
      className={cn("relative w-full touch-pan-y select-none", className)}
      style={{ height }}
      onPointerMove={(event) =>
        event.pointerType === "mouse" && inspect(event, false)
      }
      onPointerLeave={(event) =>
        event.pointerType === "mouse" && setInspected(undefined)
      }
      onPointerDown={(event) =>
        event.pointerType !== "mouse" && inspect(event, true)
      }
    >
      {width > 0 && count > 0 ? (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role="img"
          aria-label={layers
            .map(
              (layer, index) =>
                `${layer.label}: peak ${peaks[index] ? format(peaks[index]!.value) : "none"}`,
            )
            .join("; ")}
        >
          {[0, 0.5, 1].map((share) => (
            <g key={share}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(top * share)}
                y2={y(top * share)}
                className="stroke-border"
                strokeDasharray={share === 0 ? undefined : "2 4"}
              />
              {axis ? (
                <text
                  x={pad.left - 6}
                  y={y(top * share) + 3}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {format(top * share)}
                </text>
              ) : null}
            </g>
          ))}
          {markers.map((marker) => {
            const at = atX(marker.at);
            if (at < pad.left || at > width - pad.right) return null;
            return (
              <g key={`${marker.at}-${marker.label}`}>
                <title>{marker.label}</title>
                <line
                  x1={at}
                  x2={at}
                  y1={pad.top - 6}
                  y2={pad.top + plotHeight}
                  stroke={TONE[marker.tone]}
                  strokeOpacity={0.45}
                  strokeDasharray="2 3"
                />
                <circle
                  cx={at}
                  cy={pad.top - 8}
                  r={3}
                  fill={TONE[marker.tone]}
                />
              </g>
            );
          })}
          {layers.map((layer, index) => {
            const upper = tops[index]!;
            const lower = index === 0 ? undefined : tops[index - 1]!;
            return (
              <g key={layer.key}>
                {runs(upper).map(([first, last]) => {
                  const line = range(first, last)
                    .map((point) => `${x(point)},${y(upper[point]!)}`)
                    .join("L");
                  const base = range(first, last)
                    .reverse()
                    .map((point) => `${x(point)},${y(lower?.[point] ?? 0)}`)
                    .join("L");
                  return (
                    <g key={first}>
                      <path
                        d={`M${line}L${base}Z`}
                        fill={layer.color}
                        fillOpacity={layers.length > 1 ? 0.5 : 0.16}
                      />
                      <path
                        d={`M${line}`}
                        fill="none"
                        stroke={layer.color}
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {median !== undefined && layers.length === 1 ? (
            <g>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(median)}
                y2={y(median)}
                className="stroke-foreground"
                strokeOpacity={0.55}
                strokeDasharray="5 4"
              />
              <Tag
                x={
                  medianSide(peaks[0], count) === "left"
                    ? pad.left + 2
                    : width - pad.right - 2
                }
                y={y(median) - 4}
                anchor={
                  medianSide(peaks[0], count) === "left" ? "start" : "end"
                }
                text={`median ${format(median)}`}
                quiet
              />
            </g>
          ) : null}
          {flagged(layers, peaks, tops, top, axis ? 0.04 : 0).map((index) => {
            const layer = layers[index]!;
            const peak = peaks[index]!;
            const stackedPeak =
              (index === 0 ? 0 : (tops[index - 1]![peak.index] ?? 0)) +
              peak.value;
            const px = x(peak.index);
            const right = px > pad.left + plotWidth * 0.62;
            return (
              <g key={`peak-${layer.key}`}>
                <line
                  x1={px}
                  x2={px}
                  y1={y(stackedPeak)}
                  y2={y(stackedPeak) - 8}
                  stroke={layer.color}
                  strokeWidth={1.5}
                />
                <circle
                  cx={px}
                  cy={y(stackedPeak)}
                  r={3.5}
                  className="fill-card"
                  stroke={layer.color}
                  strokeWidth={2}
                />
                <Tag
                  x={right ? px - 4 : px + 4}
                  y={y(stackedPeak) - 10}
                  anchor={right ? "end" : "start"}
                  text={`${layers.length > 1 ? `${layer.label} ` : "peak "}${format(peak.value)}`}
                  color={layer.color}
                />
              </g>
            );
          })}
          {axis
            ? [0, Math.floor((count - 1) / 2), count - 1].map(
                (point, index) => (
                  <text
                    key={point}
                    x={x(point)}
                    y={height - 4}
                    textAnchor={
                      index === 0 ? "start" : index === 2 ? "end" : "middle"
                    }
                    className="fill-muted-foreground text-[10px] tabular-nums"
                  >
                    {index === 2
                      ? "now"
                      : timeLabel(
                          report.from + point * report.step,
                          report.range,
                        )}
                  </text>
                ),
              )
            : null}
          {inspected !== undefined ? (
            <line
              x1={x(inspected)}
              x2={x(inspected)}
              y1={pad.top}
              y2={pad.top + plotHeight}
              className="stroke-foreground"
              strokeOpacity={0.35}
            />
          ) : null}
        </svg>
      ) : null}
      {inspected !== undefined && width > 0 ? (
        <div
          className={cn(
            "pointer-events-none absolute top-1 z-10 min-w-32 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
          )}
          style={
            x(inspected) > width / 2
              ? { right: width - x(inspected) + 8 }
              : { left: x(inspected) + 8 }
          }
        >
          <div className="mb-1 font-medium tabular-nums">
            {timeLabel(report.from + inspected * report.step, report.range)}
          </div>
          {layers.map((layer) => (
            <div key={layer.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-sm"
                style={{ background: layer.color }}
              />
              <span className="min-w-0 flex-1 truncate">{layer.label}</span>
              <span className="font-mono text-[11px] tabular-nums">
                {layer.average[inspected] === null
                  ? "–"
                  : format(layer.average[inspected]!)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A small label with a halo in the card's colour, so it reads over the lines it sits on. */
function Tag({
  x,
  y,
  anchor,
  text,
  color,
  quiet = false,
}: {
  x: number;
  y: number;
  anchor: "start" | "end";
  text: string;
  color?: string;
  quiet?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className={cn(
        "stroke-card text-[10px] tabular-nums [paint-order:stroke]",
        quiet ? "fill-muted-foreground" : "font-semibold",
      )}
      strokeWidth={3}
      strokeLinejoin="round"
      style={color ? { fill: color } : undefined}
    >
      {text}
    </text>
  );
}

/** Which layers' peaks get a flag: in a stack, only those that stand out (at least `share` of the scale) and do not
 * land on a bigger one's flag; the biggest is always flagged. */
function flagged(
  layers: readonly ChartLayer[],
  peaks: readonly ({ index: number; value: number } | undefined)[],
  tops: readonly (readonly (number | null)[])[],
  top: number,
  share: number,
): number[] {
  const order = layers
    .map((_, index) => index)
    .filter((index) => peaks[index] !== undefined)
    .sort((a, b) => peaks[b]!.value - peaks[a]!.value);
  const placed: { point: number; height: number }[] = [];
  const count = layers[0]?.average.length ?? 1;
  return order.filter((index, rank) => {
    const peak = peaks[index]!;
    const height =
      (index === 0 ? 0 : (tops[index - 1]![peak.index] ?? 0)) + peak.value;
    const crowded = placed.some(
      (other) =>
        Math.abs(other.point - peak.index) < count * 0.18 &&
        Math.abs(other.height - height) < top * 0.12,
    );
    if (rank > 0 && (peak.value < top * share || crowded)) return false;
    placed.push({ point: peak.index, height });
    return true;
  });
}

/** The median's label goes on the side away from the peak, so the two never overlap. */
function medianSide(
  peak: { index: number } | undefined,
  count: number,
): "left" | "right" {
  return peak && peak.index > count * 0.45 ? "left" : "right";
}

/** The runs of consecutive points with a value: a chart draws each run as one shape, with gaps between. */
function runs(values: readonly (number | null)[]): [number, number][] {
  const found: [number, number][] = [];
  let start: number | undefined;
  values.forEach((value, index) => {
    if (value !== null && start === undefined) start = index;
    if (value === null && start !== undefined) {
      found.push([start, index - 1]);
      start = undefined;
    }
  });
  if (start !== undefined) found.push([start, values.length - 1]);
  return found;
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
