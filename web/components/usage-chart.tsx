"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chartLayout, type Peak } from "@/lib/chart-layout";
import { timeLabel, type ChartMarker, type ChartReport } from "@/lib/usage";
import { cn } from "@/lib/utils";

export type { ChartMarker };

/** One layer of a chart: a series' values of one measure. */
export interface ChartLayer {
  readonly key: string;
  readonly label: string;
  /** A CSS colour, normally a chart token such as `var(--chart-3)`. */
  readonly color: string;
  readonly average: readonly (number | null)[];
  readonly peak?: Peak;
}

const TONE = {
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
} as const;
const PAD = { top: 22, right: 6, bottom: 18, left: 40 } as const;

/** A usage chart: one measure over a range, its layers stacked when there are several. Each layer's peak is flagged
 * where it happened; a single layer also gets its median as a dashed line. Markers stand on the time axis. Pointing at
 * the chart, tapping it on a phone, or focusing it and using the arrow keys shows a moment's values; a second tap,
 * leaving it, or Escape hides them. */
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
  const [picked, setPicked] = useState<number | undefined>();
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
  // A shorter range may arrive while a point is picked; one past the end is simply not shown.
  const inspected = picked !== undefined && picked < count ? picked : undefined;
  // Inspecting redraws only the cursor and readout: the geometry depends on the data and the size alone.
  const layout = useMemo(
    () =>
      chartLayout({
        layers,
        from: report.from,
        step: report.step,
        width,
        height,
        pad: axis ? PAD : { ...PAD, left: 2, bottom: 2 },
        floor,
        labelOf: (index, peak) => ({
          name: layers.length > 1 ? layers[index]!.label : "peak",
          value: format(peak.value),
        }),
      }),
    [layers, report.from, report.step, width, height, axis, floor, format],
  );
  const { plot, stacks, y, pointX } = layout;
  const top = layout.top;
  const valuesAt = (point: number) =>
    layers
      .map(
        (layer) =>
          `${layer.label} ${layer.average[point] === null ? "nothing sampled" : format(layer.average[point]!)}`,
      )
      .join(", ");
  const inspectAt = (clientX: number, toggle: boolean) => {
    const box = frame.current!.getBoundingClientRect();
    const index = layout.indexAt(clientX - box.left);
    setPicked((current) => (toggle && current === index ? undefined : index));
  };

  return (
    <div
      ref={frame}
      tabIndex={count > 0 ? 0 : undefined}
      role="group"
      aria-label={`${layers
        .map(
          (layer) =>
            `${layer.label}: peak ${layer.peak ? format(layer.peak.value) : "none"}`,
        )
        .join("; ")}. Use the arrow keys to read each moment.`}
      className={cn(
        "relative w-full touch-pan-y rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      style={{ height }}
      onPointerMove={(event) =>
        event.pointerType === "mouse" && inspectAt(event.clientX, false)
      }
      onPointerLeave={(event) =>
        event.pointerType === "mouse" && setPicked(undefined)
      }
      onPointerDown={(event) =>
        event.pointerType !== "mouse" && inspectAt(event.clientX, true)
      }
      onBlur={() => setPicked(undefined)}
      onKeyDown={(event) => {
        if (count === 0) return;
        const last = count - 1;
        const next =
          event.key === "ArrowLeft"
            ? Math.max((inspected ?? count) - 1, 0)
            : event.key === "ArrowRight"
              ? Math.min((inspected ?? -1) + 1, last)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : event.key === "Escape"
                    ? null
                    : undefined;
        if (next === undefined) return;
        event.preventDefault();
        setPicked(next ?? undefined);
      }}
    >
      {width > 0 && count > 0 ? (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          aria-hidden
        >
          {[0, 0.5, 1].map((share) => (
            <g key={share}>
              <line
                x1={plot.left}
                x2={plot.right}
                y1={y(top * share)}
                y2={y(top * share)}
                className="stroke-border"
                strokeDasharray={share === 0 ? undefined : "2 4"}
              />
              {axis ? (
                <text
                  x={plot.left - 6}
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
            const at = layout.timeX(marker.at);
            if (at < plot.left || at > plot.right) return null;
            return (
              <g key={`${marker.at}-${marker.label}`}>
                <title>{marker.label}</title>
                <line
                  x1={at}
                  x2={at}
                  y1={plot.top - 6}
                  y2={plot.bottom}
                  stroke={TONE[marker.tone]}
                  strokeOpacity={0.45}
                  strokeDasharray="2 3"
                />
                <circle
                  cx={at}
                  cy={plot.top - 8}
                  r={3}
                  fill={TONE[marker.tone]}
                />
              </g>
            );
          })}
          {layers.map((layer, index) => {
            const upper = stacks[index]!;
            const lower = index === 0 ? undefined : stacks[index - 1]!;
            return (
              <g key={layer.key}>
                {runs(upper).map(([first, last]) => {
                  const line = span(first, last)
                    .map((point) => `${pointX(point)},${y(upper[point]!)}`)
                    .join("L");
                  const base = span(first, last)
                    .reverse()
                    .map(
                      (point) => `${pointX(point)},${y(lower?.[point] ?? 0)}`,
                    )
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
                x1={plot.left}
                x2={plot.right}
                y1={y(median)}
                y2={y(median)}
                className="stroke-foreground"
                strokeOpacity={0.55}
                strokeDasharray="5 4"
              />
              <Tag
                x={
                  medianSide(layers[0]!.peak, count) === "left"
                    ? plot.left + 2
                    : plot.right - 2
                }
                y={y(median) - 4}
                anchor={
                  medianSide(layers[0]!.peak, count) === "left"
                    ? "start"
                    : "end"
                }
                text={`median ${format(median)}`}
                quiet
              />
            </g>
          ) : null}
          {layout.flags.map((flag) => {
            const layer = layers[flag.layer]!;
            // A moved label's leader meets the edge nearer its point.
            const reach =
              flag.labelX >= flag.x
                ? flag.labelX
                : flag.labelX + flag.labelWidth;
            return (
              <g key={`peak-${layer.key}`}>
                <line
                  x1={flag.x}
                  x2={flag.moved ? reach : flag.x}
                  y1={flag.y}
                  y2={flag.moved ? flag.labelY - 3 : flag.y - 8}
                  stroke={layer.color}
                  strokeWidth={flag.moved ? 1 : 1.5}
                />
                <circle
                  cx={flag.x}
                  cy={flag.y}
                  r={3.5}
                  className="fill-card"
                  stroke={layer.color}
                  strokeWidth={2}
                />
                <Tag
                  x={flag.labelX}
                  y={flag.labelY}
                  anchor="start"
                  text={flag.text}
                />
              </g>
            );
          })}
          {axis
            ? [0, Math.floor((count - 1) / 2), count - 1].map(
                (point, index) => (
                  <text
                    key={point}
                    x={
                      index === 0
                        ? plot.left
                        : index === 2
                          ? plot.right
                          : pointX(point)
                    }
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
              x1={pointX(inspected)}
              x2={pointX(inspected)}
              y1={plot.top}
              y2={plot.bottom}
              className="stroke-foreground"
              strokeOpacity={0.35}
            />
          ) : null}
        </svg>
      ) : null}
      <span role="status" className="sr-only">
        {inspected !== undefined
          ? `${timeLabel(report.from + inspected * report.step, report.range)}: ${valuesAt(inspected)}`
          : ""}
      </span>
      {inspected !== undefined && width > 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={
            pointX(inspected) > width / 2
              ? { right: width - pointX(inspected) + 8 }
              : { left: pointX(inspected) + 8 }
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
  quiet = false,
}: {
  x: number;
  y: number;
  anchor: "start" | "end";
  text: string;
  quiet?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className={cn(
        "stroke-card text-[10px] tabular-nums [paint-order:stroke]",
        // Ink, not the series' colour: chart colours are too light to read as text; the point beside it carries the colour.
        quiet ? "fill-muted-foreground" : "fill-foreground font-semibold",
      )}
      strokeWidth={3}
      strokeLinejoin="round"
    >
      {text}
    </text>
  );
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

function span(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
