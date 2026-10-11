/**
 * `parquetSource` hands the display grids their bytes as a Blob, which
 * data-table 0.9+ reads from disk instead of copying into DuckDB's wasm heap.
 * What must hold is that the Blob carries exactly the bytes of the view it was
 * given — a regression to `bytes.buffer` would ship the whole backing buffer,
 * and a parquet file with trailing bytes no longer ends in its footer.
 *
 * Node's Blob takes a SharedArrayBuffer view where the browser's refuses one,
 * so this cannot show the refusal; it shows the copied-out branch is exact.
 */
import { describe, expect, it } from 'vitest';
import { parquetSource } from '../../../src/core/bridge/tables';

const bytesOf = async (blob: Blob): Promise<number[]> =>
  Array.from(new Uint8Array(await blob.arrayBuffer()));

describe('parquetSource', () => {
  it('carries exactly the bytes it was given', async () => {
    const blob = parquetSource(new Uint8Array([0x50, 0x41, 0x52, 0x31, 9, 8, 7]));
    expect(blob.size).toBe(7);
    expect(await bytesOf(blob)).toEqual([0x50, 0x41, 0x52, 0x31, 9, 8, 7]);
  });

  it("takes a view's own window, not its whole backing buffer", async () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const blob = parquetSource(backing.subarray(2, 5));
    expect(await bytesOf(blob)).toEqual([3, 4, 5]);
  });

  it('copies a SharedArrayBuffer-backed view out exactly', async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(6));
    shared.set([10, 11, 12, 13, 14, 15]);
    const blob = parquetSource(shared.subarray(1, 4));
    expect(await bytesOf(blob)).toEqual([11, 12, 13]);
  });
});
