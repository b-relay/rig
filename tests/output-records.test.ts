import { expect, test } from "bun:test";
import {
  MAX_RECORD_LINE_BYTES,
  outputLines,
  recordPieces,
} from "../src/domain/output-records";

const lines = (chunks: readonly (Uint8Array | string)[]) => {
  const stream = outputLines();
  return [...chunks.flatMap((chunk) => stream.push(chunk)), ...stream.end()];
};

test("a stream cut into two chunks at any byte gives the same record lines", () => {
  const bytes = Buffer.from("a€é😀✓\r\nsecond 😀 line\n\nlast é");
  const whole = ["a€é😀✓", "second 😀 line", "", "last é"];
  expect(lines([bytes])).toEqual(whole);
  for (let cut = 1; cut < bytes.length; cut++)
    expect(lines([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(whole);
  expect(lines([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(whole);
});

test("decoded text chunks are split the same way, and a stream that ends partway through a character keeps the rest", () => {
  expect(lines(["one\ntw", "o\r", "\nthree"])).toEqual(["one", "two", "three"]);
  expect(lines([Buffer.from([0x61, 0xf0, 0x9f])])).toEqual(["a\uFFFD"]);
  expect(lines([])).toEqual([]);
  expect(lines(["done\n"])).toEqual(["done"]);
});

test("a line longer than a record is cut between characters into pieces that join back, with or without its newline", () => {
  const long =
    "a".repeat(MAX_RECORD_LINE_BYTES - 1) + "😀".repeat(40_000) + "é";
  for (const pieces of [
    recordPieces(long),
    lines([long + "\n"]),
    lines([Buffer.from(long)]),
    lines(
      Array.from({ length: Math.ceil(long.length / 1000) }, (_, n) =>
        long.slice(n * 1000, (n + 1) * 1000),
      ),
    ),
  ]) {
    expect(pieces.join("")).toBe(long);
    expect(pieces[0]).toBe("a".repeat(MAX_RECORD_LINE_BYTES - 1));
    for (const piece of pieces) {
      expect(piece.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(
        MAX_RECORD_LINE_BYTES,
      );
    }
  }
  expect(recordPieces("short")).toEqual(["short"]);
});

test("a newline-free run is given out a record at a time as it grows, holding back no more than one record", () => {
  const stream = outputLines();
  const chunk = "x".repeat(10_000);
  const out: string[] = [];
  for (let n = 0; n < 20; n++) out.push(...stream.push(chunk));
  expect(out.length).toBe(
    Math.floor((20 * 10_000 - 1) / MAX_RECORD_LINE_BYTES),
  );
  out.push(...stream.end());
  expect(out.join("")).toBe(chunk.repeat(20));
  expect(out.every((piece) => piece.length <= MAX_RECORD_LINE_BYTES)).toBe(
    true,
  );
});
