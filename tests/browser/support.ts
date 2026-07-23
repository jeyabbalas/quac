/** Shared helpers for the browser-tier bridge spikes (not a test file). */

/** Poll `cond` until true or fail with a description after `timeoutMs`. */
export async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Copy a Uint8Array into a standalone ArrayBuffer (createDataTable source). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/** First four bytes of every Parquet file ('PAR1'). */
export const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31];
