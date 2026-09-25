// Minimal zip reader for the output checks: lists and inflates the entries of a
// Playwright trace.zip so the PII scan and the network-host check can read them.
// Zero-dep on purpose (the engine has none). Fail-closed: any archive feature it does
// not handle (zip64, encryption, a compression method other than stored/deflate, an
// entry over the size bound) throws instead of skipping the entry unread.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Bound on one inflated entry: a trace entry is at most a few MB; this catches a bomb. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function findEocd(buf) {
  const floor = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip archive (no end-of-central-directory record)");
}

function inflateEntry(buf, entry) {
  const { name, method, localOffset, compressedSize, size } = entry;
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
    throw new Error(`zip entry ${name}: bad local header`);
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compressedSize);
  if (raw.length !== compressedSize) throw new Error(`zip entry ${name}: truncated data`);
  if (method === 0) return raw;
  if (method === 8) {
    const out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    if (out.length !== size) throw new Error(`zip entry ${name}: size mismatch after inflate`);
    return out;
  }
  throw new Error(`zip entry ${name}: unsupported compression method ${method}`);
}

/**
 * Every file entry of the archive, inflated.
 * @param {Buffer} buf the whole archive
 * @returns {{name: string, data: Buffer}[]}
 */
export function readZipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not read");
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error("zip central directory is corrupt");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error(`zip entry ${name}: encrypted`);
    if (size > MAX_ENTRY_BYTES) throw new Error(`zip entry ${name}: over the size bound`);
    entries.push({
      name,
      data: inflateEntry(buf, { name, method, localOffset, compressedSize, size }),
    });
  }
  return entries;
}
