import { roundedTop, stacked } from "./usage";

/** Where a range's highest sample fell (the point) and what it was. */
export interface Peak {
  readonly index: number;
  readonly value: number;
}

/** One layer of a chart: its average per point (`null` where nothing was sampled) and its peak. */
export interface LayoutLayer {
  readonly average: readonly (number | null)[];
  readonly peak?: Peak;
}

/** A layer's peak as drawn: the point, and its label, moved clear of the other labels. */
export interface PeakFlag {
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** The label's left edge and its estimated width, inside the chart. */
  readonly labelX: number;
  readonly labelWidth: number;
  /** The label's baseline. */
  readonly labelY: number;
  /** The label was moved off its point's row, so a leader line joins them. */
  readonly moved: boolean;
}

/** A chart's geometry, in SVG pixels: the scale, one mapping from time to `x` that points, markers and inspection all
 * share, and every sampled layer's peak flag. */
export interface ChartLayout {
  /** The scale's top, in the measure's unit. */
  readonly top: number;
  readonly plot: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  /** Each layer's running total, point by point. */
  readonly stacks: readonly (readonly (number | null)[])[];
  readonly flags: readonly PeakFlag[];
  /** `x` of a time, Unix seconds. */
  timeX(at: number): number;
  /** `x` of a point: the middle of the span it covers. */
  pointX(index: number): number;
  /** The point under `x`. */
  indexAt(x: number): number;
  y(value: number): number;
}

/** Roughly how wide a label is: the chart's labels are 10px semibold digits and short names. */
const LABEL_CHARACTER = 6;
const LABEL_HEIGHT = 11;

/** Pure: the geometry of a chart of `layers` over `count` points of `step` seconds from `from`, in a `width` by
 * `height` box with `pad` around the plot. Point `i` covers `from + i * step` up to the next, and is drawn in the
 * middle of it. The scale reaches above the highest stack and every stacked peak, never below `floor`. Every layer
 * with a peak is flagged, highest first, each label kept inside the chart and put in the nearest row, on either side
 * of its point, clear of the labels before it. */
export function chartLayout({
  layers,
  from,
  step,
  width,
  height,
  pad,
  floor,
  labelOf,
}: {
  layers: readonly LayoutLayer[];
  from: number;
  step: number;
  width: number;
  height: number;
  pad: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  floor: number;
  labelOf: (layer: number, peak: Peak) => string;
}): ChartLayout {
  const count = layers[0]?.average.length ?? 0;
  const plot = {
    left: pad.left,
    right: Math.max(width - pad.right, pad.left + 1),
    top: pad.top,
    bottom: height - pad.bottom,
  };
  const plotWidth = plot.right - plot.left;
  const stacks = stacked(layers.map((layer) => layer.average));
  const peakHeight = (layer: number, peak: Peak) =>
    (layer === 0 ? 0 : (stacks[layer - 1]![peak.index] ?? 0)) + peak.value;
  const highest = Math.max(
    0,
    ...stacks.flatMap((layer) => layer.map((value) => value ?? 0)),
    ...layers.map((layer, index) =>
      layer.peak ? peakHeight(index, layer.peak) : 0,
    ),
  );
  const top = roundedTop(highest * 1.1, floor);
  const span = Math.max(count * step, 1);
  const timeX = (at: number) => plot.left + ((at - from) / span) * plotWidth;
  const y = (value: number) =>
    plot.bottom - (value / top) * (plot.bottom - plot.top);

  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const flags = layers
    .map((layer, index) => ({ layer: index, peak: layer.peak }))
    .filter((each): each is { layer: number; peak: Peak } => !!each.peak)
    .sort((a, b) => peakHeight(b.layer, b.peak) - peakHeight(a.layer, a.peak))
    .map(({ layer, peak }): PeakFlag => {
      const x = timeX(from + (peak.index + 0.5) * step);
      const py = y(peakHeight(layer, peak));
      const text = labelOf(layer, peak);
      const wide = text.length * LABEL_CHARACTER;
      // Right of the point where the label fits there, else left of it; either way kept inside the chart.
      const inside = (left: number) =>
        Math.max(0, Math.min(left, width - wide));
      const right = inside(x + 4);
      const left = inside(x - 4 - wide);
      const sides = x + 4 + wide <= width ? [right, left] : [left, right];
      const boxAt = (x0: number, baseline: number) => ({
        x0,
        x1: x0 + wide,
        y0: baseline - LABEL_HEIGHT + 2,
        y1: baseline + 2,
      });
      const clear = (box: ReturnType<typeof boxAt>) =>
        box.y0 >= 0 &&
        box.y1 <= height &&
        boxes.every(
          (other) =>
            other.x1 <= box.x0 ||
            box.x1 <= other.x0 ||
            other.y1 <= box.y0 ||
            box.y1 <= other.y0,
        );
      // Rows nearest the point first, through the chart's whole height, each tried on both sides of the point.
      const natural = py - 10;
      const rows = Math.ceil(height / (LABEL_HEIGHT + 1));
      const candidates = Array.from({ length: 2 * rows + 1 }, (_, index) =>
        index === 0
          ? 0
          : (index % 2 === 1 ? -1 : 1) *
            Math.ceil(index / 2) *
            (LABEL_HEIGHT + 1),
      ).flatMap((offset) =>
        sides.map((x0) => ({ x0, baseline: natural + offset })),
      );
      // A chart with more peaks than room for labels overlaps the last ones rather than hide a peak.
      const chosen = candidates.find(({ x0, baseline }) =>
        clear(boxAt(x0, baseline)),
      ) ?? { x0: sides[0]!, baseline: natural };
      boxes.push(boxAt(chosen.x0, chosen.baseline));
      return {
        layer,
        x,
        y: py,
        text,
        labelX: chosen.x0,
        labelWidth: wide,
        labelY: chosen.baseline,
        moved: chosen.baseline !== natural,
      };
    });

  return {
    top,
    plot,
    stacks,
    flags,
    timeX,
    pointX: (index) => timeX(from + (index + 0.5) * step),
    indexAt: (x) =>
      Math.min(
        count - 1,
        Math.max(0, Math.floor(((x - plot.left) / plotWidth) * count)),
      ),
    y,
  };
}
