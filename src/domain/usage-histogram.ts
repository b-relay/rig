/** The distribution of one usage measure over a span of time, kept as counts in log-scale buckets plus the exact
 * count, sum, lowest and highest value. Histograms of the same measure merge by adding counts, so the median or p95 of
 * any span can be estimated from the minute histograms it covers, which per-minute medians could not give.
 *
 * Values are whole numbers in the measure's storage unit (tenths of a percent of a core for CPU, KiB for memory). */
export interface UsageHistogram {
  readonly count: number;
  readonly sum: number;
  readonly low: number;
  readonly high: number;
  /** Bucket index to how many values fell in it; see `bucketOf`. Indexes with no values are absent. */
  readonly buckets: ReadonlyMap<number, number>;
}

/** Buckets per doubling of the value. Eight keeps any estimate within about 4.5% of the true value. */
const BUCKETS_PER_DOUBLING = 8;
const ENCODING_VERSION = 1;
const HEADER_BYTES = 1 + 4 + 8 + 4 + 4 + 2;
const BUCKET_BYTES = 2 + 4;

/** Pure: the bucket a value falls in. 0 holds only zero; bucket `i` above that holds values from `2^((i-1)/8)` up to
 * `2^(i/8)`. */
export function bucketOf(value: number): number {
  return value < 1
    ? 0
    : 1 + Math.floor(Math.log2(value) * BUCKETS_PER_DOUBLING + 1e-9);
}

/** Pure: the histogram of some values, or `undefined` when there are none (no usage was recorded, which is not the same
 * as a usage of zero). */
export function histogramOf(
  values: readonly number[],
): UsageHistogram | undefined {
  if (values.length === 0) return undefined;
  const buckets = new Map<number, number>();
  let sum = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    sum += value;
    low = Math.min(low, value);
    high = Math.max(high, value);
    const bucket = bucketOf(value);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return { count: values.length, sum, low, high, buckets };
}

/** Pure: one histogram holding every value of the given ones, or `undefined` when there are none. */
export function mergeHistograms(
  histograms: Iterable<UsageHistogram | undefined>,
): UsageHistogram | undefined {
  const buckets = new Map<number, number>();
  let count = 0;
  let sum = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const histogram of histograms) {
    if (histogram === undefined) continue;
    count += histogram.count;
    sum += histogram.sum;
    low = Math.min(low, histogram.low);
    high = Math.max(high, histogram.high);
    for (const [bucket, n] of histogram.buckets)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + n);
  }
  return count === 0 ? undefined : { count, sum, low, high, buckets };
}

/** Pure: the estimated value below which a `fraction` (0 to 1) of the values fall: 0.5 is the median, 0.95 the p95.
 * The estimate is the middle of the bucket the value falls in, kept within the histogram's exact low and high, so the
 * 0 and 1 fractions return them exactly. */
export function quantileOf(
  histogram: UsageHistogram,
  fraction: number,
): number {
  if (fraction <= 0) return histogram.low;
  if (fraction >= 1) return histogram.high;
  const rank = fraction * histogram.count;
  let seen = 0;
  for (const bucket of [...histogram.buckets.keys()].sort((a, b) => a - b)) {
    seen += histogram.buckets.get(bucket)!;
    if (seen >= rank) return clamp(middleOf(bucket), histogram);
  }
  return histogram.high;
}

function middleOf(bucket: number): number {
  return bucket === 0 ? 0 : 2 ** ((bucket - 0.5) / BUCKETS_PER_DOUBLING);
}

function clamp(value: number, histogram: UsageHistogram): number {
  return Math.min(histogram.high, Math.max(histogram.low, value));
}

/** Pure: the histogram as bytes for storage; `decodeHistogram` reads it back unchanged. */
export function encodeHistogram(histogram: UsageHistogram): Uint8Array {
  const bytes = new Uint8Array(
    HEADER_BYTES + histogram.buckets.size * BUCKET_BYTES,
  );
  const view = new DataView(bytes.buffer);
  view.setUint8(0, ENCODING_VERSION);
  view.setUint32(1, histogram.count);
  view.setFloat64(5, histogram.sum);
  view.setUint32(13, histogram.low);
  view.setUint32(17, histogram.high);
  view.setUint16(21, histogram.buckets.size);
  let offset = HEADER_BYTES;
  for (const [bucket, n] of histogram.buckets) {
    view.setUint16(offset, bucket);
    view.setUint32(offset + 2, n);
    offset += BUCKET_BYTES;
  }
  return bytes;
}

/** Pure: a histogram from bytes `encodeHistogram` wrote, or `undefined` when the bytes are not such a histogram (a
 * damaged row is skipped rather than failing a whole chart). */
export function decodeHistogram(bytes: Uint8Array): UsageHistogram | undefined {
  if (bytes.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== ENCODING_VERSION) return undefined;
  const size = view.getUint16(21);
  if (bytes.byteLength !== HEADER_BYTES + size * BUCKET_BYTES) return undefined;
  const buckets = new Map<number, number>();
  for (let i = 0; i < size; i++) {
    const offset = HEADER_BYTES + i * BUCKET_BYTES;
    buckets.set(view.getUint16(offset), view.getUint32(offset + 2));
  }
  return {
    count: view.getUint32(1),
    sum: view.getFloat64(5),
    low: view.getUint32(13),
    high: view.getUint32(17),
    buckets,
  };
}
