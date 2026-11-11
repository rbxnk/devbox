// hc framed mode: [channel u32 LE][kind u8][len u32 LE][payload]. See herdr-core schema/README.md.
export const DATA = 0, CREDIT = 1, CLOSE = 2, RESIZE = 3, FOCUS = 4, FACTS = 5;
export const HEADER = 9;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export type Frame = { channel: number; kind: number; payload: Uint8Array };

export function encode(channel: number, kind: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(HEADER + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, channel, true);
  v.setUint8(4, kind);
  v.setUint32(5, payload.length, true);
  out.set(payload, HEADER);
  return out;
}

/** One whole frame, or null when the bytes are not exactly one valid frame. */
export function decodeOne(buf: Uint8Array): Frame | null {
  if (buf.length < HEADER) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = v.getUint32(5, true);
  if (len > MAX_PAYLOAD || buf.length !== HEADER + len) return null;
  return { channel: v.getUint32(0, true), kind: v.getUint8(4), payload: buf.subarray(HEADER) };
}

/** Reassembles frames from a byte stream split anywhere. Throws on an oversized frame. */
export function decoder(onFrame: (frame: Frame, raw: Uint8Array) => void): (chunk: Uint8Array) => void {
  let buf: Uint8Array = new Uint8Array(0);
  return (chunk) => {
    if (buf.length) {
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf);
      joined.set(chunk, buf.length);
      buf = joined;
    } else buf = chunk;
    while (buf.length >= HEADER) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(5, true);
      if (len > MAX_PAYLOAD) throw new Error('frame too large');
      if (buf.length < HEADER + len) break;
      const raw = buf.subarray(0, HEADER + len);
      onFrame(decodeOne(raw)!, raw);
      buf = buf.subarray(HEADER + len);
    }
    buf = buf.slice(); // drop the reference to the chunk we were given
  };
}

export const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
export const size = (cols: number, rows: number) => {
  const b = new Uint8Array(4); const v = new DataView(b.buffer);
  v.setUint16(0, cols, true); v.setUint16(2, rows, true); return b;
};
