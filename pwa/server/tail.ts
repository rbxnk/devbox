import fs from 'node:fs';

/** Reads whole lines appended to a file since the last call. */
/** `from`: skip everything before this byte (a partial first line is dropped by the caller). */
export function tail(file: string, from = 0): () => string[] {
  let offset = from, rest = Buffer.alloc(0);
  return () => {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return []; }
    if (size < offset) { offset = 0; rest = Buffer.alloc(0); } // replaced by a shorter file
    if (size === offset) return [];
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const all = Buffer.concat([rest, buf]);
    const end = all.lastIndexOf(10);
    rest = all.subarray(end + 1);
    return end < 0 ? [] : all.subarray(0, end).toString().split('\n').filter(Boolean);
  };
}
