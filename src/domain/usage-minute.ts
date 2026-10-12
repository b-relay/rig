import { histogramOf, type UsageHistogram } from "./usage-histogram";
import type { UsageSample } from "./usage-sample";

/** Seconds in one stored minute: a minute holds one slot per second, empty where nothing was sampled. */
export const SLOTS_PER_MINUTE = 60;
const SLOT_BYTES = 8;
const EMPTY = 0xffffffff;

/** A sample as whole numbers for storage: CPU in tenths of a percent, memory in KiB. */
export interface StoredSample {
  readonly cpu: number;
  readonly memory: number;
}

/** Both measures' histograms for one span. */
export interface UsageHistograms {
  readonly cpu: UsageHistogram;
  readonly memory: UsageHistogram;
}

/** Pure: a sample in storage units, rounded to the nearest unit and kept within what a slot can hold. */
export function storedSample(sample: UsageSample): StoredSample {
  return {
    cpu: slotValue(sample.cpuPercent * 10),
    memory: slotValue(sample.memoryBytes / 1024),
  };
}

/** Pure: CPU percent from tenths of a percent. */
export function cpuPercentOf(stored: number): number {
  return stored / 10;
}

/** Pure: bytes from KiB. */
export function memoryBytesOf(stored: number): number {
  return stored * 1024;
}

function slotValue(value: number): number {
  return Math.min(EMPTY - 1, Math.max(0, Math.round(value)));
}

/** Pure: one minute of samples as bytes for storage, one slot per second; `decodeMinute` reads it back. Slots past the
 * array's end, or `undefined`, are stored empty. */
export function encodeMinute(
  slots: readonly (StoredSample | undefined)[],
): Uint8Array {
  const bytes = new Uint8Array(SLOTS_PER_MINUTE * SLOT_BYTES);
  const view = new DataView(bytes.buffer);
  for (let second = 0; second < SLOTS_PER_MINUTE; second++) {
    const sample = slots[second];
    view.setUint32(second * SLOT_BYTES, sample?.cpu ?? EMPTY);
    view.setUint32(second * SLOT_BYTES + 4, sample?.memory ?? EMPTY);
  }
  return bytes;
}

/** Pure: the 60 slots of a minute `encodeMinute` wrote, `undefined` where a second has no sample. Bytes of any other
 * length are a damaged row and read as a minute with no samples. */
export function decodeMinute(bytes: Uint8Array): (StoredSample | undefined)[] {
  const slots: (StoredSample | undefined)[] =
    Array(SLOTS_PER_MINUTE).fill(undefined);
  if (bytes.byteLength !== SLOTS_PER_MINUTE * SLOT_BYTES) return slots;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let second = 0; second < SLOTS_PER_MINUTE; second++) {
    const cpu = view.getUint32(second * SLOT_BYTES);
    const memory = view.getUint32(second * SLOT_BYTES + 4);
    if (cpu !== EMPTY && memory !== EMPTY) slots[second] = { cpu, memory };
  }
  return slots;
}

/** Pure: the CPU and memory histograms of some samples, or `undefined` when there are none. */
export function histogramsOf(
  samples: Iterable<StoredSample | undefined>,
): UsageHistograms | undefined {
  const cpu: number[] = [];
  const memory: number[] = [];
  for (const sample of samples) {
    if (sample === undefined) continue;
    cpu.push(sample.cpu);
    memory.push(sample.memory);
  }
  const cpuHistogram = histogramOf(cpu);
  const memoryHistogram = histogramOf(memory);
  return cpuHistogram && memoryHistogram
    ? { cpu: cpuHistogram, memory: memoryHistogram }
    : undefined;
}
