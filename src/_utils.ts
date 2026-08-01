import { TLD_TO_ID, ID_TO_TLD } from './_tlds.ts';

const CHAR_DOT = 46;

export const RADIX_SEP = '|';

/** Minimal node shape shared by TrieNode<T> and SmolNode */
export interface BaseNode {
  /** key — the label (or radix-compressed labels joined by RADIX_SEP) */
  k: string,
  /** children map — label → child node, null when leaf */
  c: Map<string, BaseNode> | null,
  /** flags — bitmask of FLAG_EXACT / FLAG_SUBDOMAIN */
  f: number
}

/**
 * Walk hostname labels right-to-left (TLD first), calling `onLabel` for each.
 * The TLD label is compressed to a single-char numeric ID if it's a known TLD.
 * Returns `false` if the callback signaled early exit, `true` if fully walked.
 * Strips a single trailing dot if present.
 */
export function walkHostname(
  hostname: string,
  onLabel: (label: string) => boolean | void
): boolean {
  let end = hostname.length;
  if (end === 0) {
    return onLabel('') !== false;
  }
  if (hostname.codePointAt(end - 1) === CHAR_DOT) {
    end--;
  }

  let dotPos = hostname.lastIndexOf('.', end - 1);

  // TLD (rightmost label) — compress to numeric ID if known
  const tld = hostname.slice(dotPos + 1, end);
  const tldId = TLD_TO_ID.get(tld);
  if (onLabel(tldId ?? tld) === false) return false;

  // remaining labels right-to-left
  while (dotPos >= 0) {
    end = dotPos;
    dotPos = hostname.lastIndexOf('.', end - 1);
    if (onLabel(hostname.slice(dotPos + 1, end)) === false) return false;
  }

  return true;
}

export function splitHostname(hostname: string): string[] {
  const labels: string[] = [];
  walkHostname(hostname, (label) => { labels.push(label); });
  return labels;
}

export function labelsToHostname(labels: string[]): string {
  const len = labels.length;
  if (len === 1) {
    // single-label "hostname" — the only label IS the TLD slot, decompress if needed
    const tld = labels[0];
    return ID_TO_TLD.get(tld) ?? tld;
  }
  // last label in the stack is the leftmost subdomain, first is the TLD (possibly compressed)
  let result = labels[len - 1];
  for (let i = len - 2; i > 0; i--) {
    result += '.' + labels[i];
  }
  // first label is the TLD — decompress if needed
  const tld = labels[0];
  result += '.' + (ID_TO_TLD.get(tld) ?? tld);
  return result;
}

// ─── Shared trie operations ──────────────────────────────────────────

/** Walk hostname string, returning the leaf node or null. */
export function trieWalkFindH<N extends BaseNode>(root: N, hostname: string): N | null {
  let current: N = root;
  const completed = walkHostname(hostname, (label) => {
    const child = current.c?.get(label) as N | undefined;
    if (!child) return false;
    current = child;
  });
  return completed ? current : null;
}

/** Walk labels array, returning the leaf node or null. */
export function trieWalkFind<N extends BaseNode>(root: N, labels: string[]): N | null {
  let current: N = root;
  const len = labels.length;

  for (let i = 0; i < len; i++) {
    const child = current.c?.get(labels[i]) as N | undefined;
    if (!child) return null;
    current = child;
  }

  return current;
}

/** Walk labels in compacted (radix) mode, returning the leaf node or null. */
export function trieWalkFindCompacted<N extends BaseNode>(root: N, labels: string[]): N | null {
  let current: N = root;
  let i = 0;
  const labelsLen = labels.length;

  while (i < labelsLen) {
    const child = current.c?.get(labels[i]) as N | undefined;
    if (!child) return null;

    const parts = child.k.split(RADIX_SEP);
    const partsLen = parts.length;
    for (let p = 0; p < partsLen; p++) {
      if (i >= labelsLen || parts[p] !== labels[i]) return null;
      i++;
    }

    current = child;
  }

  return current;
}

/** Whether any node in the tree has a radix-compressed (RADIX_SEP-joined) key. */
export function trieHasCompressedKeys<N extends BaseNode>(node: N): boolean {
  if (node.k.includes(RADIX_SEP)) return true;
  if (node.c !== null) {
    for (const child of node.c.values()) {
      if (trieHasCompressedKeys(child as N)) return true;
    }
  }
  return false;
}

/** Radix-compress single-child chains in place. */
export function trieCompressNode<N extends BaseNode>(node: N): void {
  if (node.c === null) return;

  for (const child of node.c.values()) {
    trieCompressNode(child as N);
  }

  for (const [ck, child] of node.c) {
    if (
      child.c !== null
      && child.c.size === 1
      && child.f === 0
    ) {
      const grandchild = child.c.values().next().value!;
      grandchild.k = child.k + RADIX_SEP + grandchild.k;
      node.c.set(ck, grandchild);
    }
  }
}

/**
 * Expand radix-compressed nodes back to one-label-per-node.
 * `createEmpty` builds a bare node (no value fields).
 * `copyTail` copies value/data fields from the original compressed node to the expanded tail.
 */
export function trieExpandNode<N extends BaseNode>(
  node: N,
  createEmpty: (key: string) => N,
  copyTail: (tail: N, original: N) => void
): void {
  if (node.c === null) return;

  const entries = [...node.c];
  for (const [ck, child] of entries) {
    const typedChild = child as N;
    const parts = typedChild.k.split(RADIX_SEP);
    const partsLen = parts.length;
    if (partsLen > 1) {
      const head = createEmpty(parts[0]);
      let current = head;

      for (let i = 1; i < partsLen; i++) {
        const next = createEmpty(parts[i]);
        if (i === partsLen - 1) {
          next.c = typedChild.c;
          next.f = typedChild.f;
          copyTail(next, typedChild);
        }

        current.c = new Map();
        current.c.set(parts[i], next);
        current = next;
      }

      node.c.set(ck, head);
      trieExpandNode(current, createEmpty, copyTail);
    } else {
      trieExpandNode(typedChild, createEmpty, copyTail);
    }
  }
}

/** Remove empty leaf nodes bottom-up along the label path. */
export function trieCleanup<N extends BaseNode>(root: N, labels: string[]): void {
  const path: N[] = [root];
  let current: N = root;

  for (const label of labels) {
    const child = current.c?.get(label) as N | undefined;
    if (!child) return;
    path.push(child);
    current = child;
  }

  for (let i = path.length - 1; i > 0; i--) {
    const node = path[i];
    if (node.f !== 0 || (node.c !== null && node.c.size > 0)) break;
    const parent = path[i - 1];
    parent.c?.delete(node.k);
    if (parent.c?.size === 0) parent.c = null;
  }
}

// ─── Binary (transferable) serialization ─────────────────────────────
//
// Packed layout, one record per non-root node in pre-order DFS:
//   depth:        varint
//   flags:        uint8
//   keyByteLen:   varint
//   key:          keyByteLen bytes (UTF-8)
//   [if EXACT]    eByteLen + 1: varint, e: eByteLen bytes (0 == `true` sentinel)
//   [if SUBDOMAIN] sByteLen + 1: varint, s: sByteLen bytes (0 == `true` sentinel)
// Lengths and depths use one byte for the overwhelmingly common short case, but
// remain lossless for caller-supplied hostnames and values outside DNS limits.
// A 4-byte header ('H','N', version, kind) precedes all records.

const MAGIC_0 = 72;/* 'H' */
const MAGIC_1 = 78;/* 'N' */
const FORMAT_VERSION = 1;

export const BINARY_KIND_TRIE = 1;
export const BINARY_KIND_SMOL = 2;

const VARINT_CONTINUATION = 0x80;
const VARINT_PAYLOAD_MASK = 0x7F;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

// TextEncoder.encode() allocates a fresh Uint8Array per call — at thousands of
// calls (one+ per trie node) that allocation overhead dominates. encodeInto()
// writes directly into a buffer we already own, ~5x fewer allocations overall.
// Scratch is sized for the worst case: a full 255-octet FQDN, 3 bytes/char (UTF-8 max).
const ENCODE_SCRATCH_SIZE = 255 * 3;
const encodeScratch = new Uint8Array(ENCODE_SCRATCH_SIZE);

/**
 * Encodes `value` to UTF-8 bytes, preferring the shared scratch buffer (via
 * `encodeInto`, no allocation) and falling back to `encode` (one allocation)
 * only if the string is too large for scratch — returns the encoded bytes,
 * a view into `encodeScratch` in the common case.
 */
function encodeToBytes(value: string): Uint8Array {
  if (value.length === 0) return encodeScratch.subarray(0, 0);
  // value.length UTF-16 units can expand up to 3x in UTF-8 (astral pairs stay 4 bytes for 2 units, still <= 3x)
  if (value.length * 3 <= ENCODE_SCRATCH_SIZE) {
    const { written } = textEncoder.encodeInto(value, encodeScratch);
    return encodeScratch.subarray(0, written);
  }
  // rare: a caller-supplied value longer than the scratch buffer
  return textEncoder.encode(value);
}

interface NodeBufferLike {
  toString: (encoding: string, start: number, end: number) => string
}

interface NodeBufferConstructorLike {
  from: (buffer: ArrayBuffer) => NodeBufferLike
}

declare global {
  // eslint-disable-next-line vars-on-top -- `var` is required to augment globalThis
  var Buffer: NodeBufferConstructorLike | undefined;
  // eslint-disable-next-line vars-on-top -- ditto; only used to dead-code-eliminate the Buffer lookup
  var window: unknown;
}

// Node's TextDecoder#decode is markedly slower than Buffer#toString for the many
// short strings a trie decode produces, so we use Buffer when it happens to be
// there. Only verified-ASCII runs go through it, where 'latin1' is byte-identical
// to UTF-8 and cannot misdecode; anything with a high bit set still goes through
// the fatal TextDecoder, so malformed input keeps throwing rather than silently
// yielding U+FFFD.
//
// Two layers keep this from leaking into browser bundles:
//   1. `typeof window` — bundlers (Next.js, webpack, …) statically replace this in
//      browser builds, dropping the whole branch as dead code.
//   2. the global's name is built via fromCodePoint, so even bundlers that keep the
//      branch never see a literal `Buffer` reference and won't inject its polyfill.
// hntrie is fully functional without Buffer; it is purely a decode fast path.
const BUFFER_GLOBAL_NAME = String.fromCodePoint(66, 117, 102, 102, 101, 114);/* Buffer */
const nodeBufferCtor = typeof window === 'undefined'
  ? globalThis[BUFFER_GLOBAL_NAME as 'Buffer']
  : undefined;
const nodeBufferFrom = typeof nodeBufferCtor?.from === 'function'
  ? nodeBufferCtor.from.bind(nodeBufferCtor)
  : null;

/** Minimal growable byte buffer — doubles capacity on overflow, like a Vec. */
export class ByteWriter {
  private _buf: Uint8Array<ArrayBuffer>;
  private _view: DataView<ArrayBuffer>;
  private _len = 0;

  constructor(initialCapacity = 256) {
    this._buf = new Uint8Array(initialCapacity);
    this._view = new DataView(this._buf.buffer);
  }

  private _ensure(extra: number): void {
    if (this._len + extra <= this._buf.byteLength) return;
    let capacity = this._buf.byteLength * 2;
    while (capacity < this._len + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
    this._view = new DataView(this._buf.buffer);
  }

  writeU8(value: number): void {
    this._ensure(1);
    this._view.setUint8(this._len, value);
    this._len += 1;
  }

  /** LEB128 unsigned varint — 1 byte for values < 128, growing as needed. */
  writeVarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Binary serialization varint must be a non-negative safe integer');
    }
    let remaining = value;
    while (remaining >= VARINT_CONTINUATION) {
      this.writeU8((remaining % VARINT_CONTINUATION) | VARINT_CONTINUATION);
      remaining = Math.floor(remaining / VARINT_CONTINUATION);
    }
    this.writeU8(remaining);
  }

  private _writeBytes(bytes: Uint8Array): void {
    this._ensure(bytes.byteLength);
    this._buf.set(bytes, this._len);
    this._len += bytes.byteLength;
  }

  /**
   * Writes a varint byte-length prefix followed by the UTF-8 encoded string.
   *
   * Hostname labels are overwhelmingly ASCII, where one UTF-16 unit is one byte:
   * the scan that proves it also yields the byte length, so the bytes go straight
   * into the output with no TextEncoder call and no scratch round-trip. Anything
   * non-ASCII falls back to encodeInto + copy.
   */
  private _writeString(value: string, lengthBias: number): void {
    const len = value.length;

    let ascii = true;
    for (let i = 0; i < len; i++) {
      // charCodeAt (UTF-16 units), not codePointAt: one unit maps to one byte only
      // while every unit is ASCII, which is exactly the condition being tested here.
      // codePointAt would fold surrogate pairs into a single >0xFFFF value and make
      // `value.length` stop matching the byte count.
      // eslint-disable-next-line sukka/unicorn/prefer-code-point -- UTF-16 unit semantics are required, see above
      if (value.charCodeAt(i) > 0x7F) {
        ascii = false;
        break;
      }
    }

    if (ascii) {
      this.writeVarint(len + lengthBias);
      this._ensure(len);
      const buf = this._buf;
      const at = this._len;
      for (let i = 0; i < len; i++) {
        // eslint-disable-next-line sukka/unicorn/prefer-code-point -- every unit is verified ASCII, so unit === byte
        buf[at + i] = value.charCodeAt(i);
      }
      this._len = at + len;
      return;
    }

    const bytes = encodeToBytes(value);
    this.writeVarint(bytes.byteLength + lengthBias);
    this._writeBytes(bytes);
  }

  /** Writes a varint byte-length prefix followed by the UTF-8 encoded string. */
  writeKeyString(value: string): void {
    this._writeString(value, 0);
  }

  /** Writes a value string, using 0 for the boolean `true` sentinel. */
  writeValueString(value: string | null): void {
    if (value === null) {
      this.writeVarint(0);
      return;
    }
    this._writeString(value, 1);
  }

  toArrayBuffer(): ArrayBuffer {
    return this._buf.buffer.slice(0, this._len);
  }
}

/** Reads back a buffer produced by `ByteWriter`. */
export class ByteReader {
  private readonly _view: DataView<ArrayBuffer>;
  private readonly _bytes: Uint8Array<ArrayBuffer>;
  /** Node-only: wraps the same memory once, so decoding never allocates a view per string. */
  private readonly _nodeBuffer: NodeBufferLike | null;
  private _pos = 0;

  constructor(buffer: ArrayBuffer) {
    this._view = new DataView(buffer);
    this._bytes = new Uint8Array(buffer);
    this._nodeBuffer = nodeBufferFrom === null ? null : nodeBufferFrom(buffer);
  }

  get done(): boolean {
    return this._pos >= this._view.byteLength;
  }

  readU8(): number {
    const value = this._view.getUint8(this._pos);
    this._pos += 1;
    return value;
  }

  readVarint(): number {
    let result = 0;
    let multiplier = 1;

    while (true) {
      const byte = this.readU8();
      const payload = byte & VARINT_PAYLOAD_MASK;
      if (payload > (Number.MAX_SAFE_INTEGER - result) / multiplier) {
        throw new RangeError('Binary serialization varint exceeds Number.MAX_SAFE_INTEGER');
      }
      result += payload * multiplier;
      if ((byte & VARINT_CONTINUATION) === 0) return result;
      if (multiplier > Number.MAX_SAFE_INTEGER / VARINT_CONTINUATION) {
        throw new RangeError('Binary serialization varint exceeds Number.MAX_SAFE_INTEGER');
      }
      multiplier *= VARINT_CONTINUATION;
    }
  }

  private _readString(byteLength: number): string {
    const start = this._pos;
    if (byteLength > this._view.byteLength - start) {
      throw new RangeError('Unexpected end of hntrie binary serialization');
    }
    const end = start + byteLength;
    this._pos = end;

    if (this._nodeBuffer !== null) {
      // 'latin1' is byte-identical to UTF-8 for ASCII and skips UTF-8 validation
      let ascii = true;
      for (let i = start; i < end; i++) {
        if (this._bytes[i] > 0x7F) {
          ascii = false;
          break;
        }
      }
      if (ascii) return this._nodeBuffer.toString('latin1', start, end);
    }

    // non-ASCII (or no Buffer): the fatal decoder rejects malformed UTF-8
    return textDecoder.decode(this._bytes.subarray(start, end));
  }

  readKeyString(): string {
    return this._readString(this.readVarint());
  }

  readValueString(): string | null {
    const encodedByteLength = this.readVarint();
    if (encodedByteLength === 0) return null;
    return this._readString(encodedByteLength - 1);
  }
}

export function writeBinaryHeader(writer: ByteWriter, kind: number): void {
  writer.writeU8(MAGIC_0);
  writer.writeU8(MAGIC_1);
  writer.writeU8(FORMAT_VERSION);
  writer.writeU8(kind);
}

export function readBinaryHeader(reader: ByteReader, expectedKind: number): void {
  if (
    reader.readU8() !== MAGIC_0
    || reader.readU8() !== MAGIC_1
    || reader.readU8() !== FORMAT_VERSION
    || reader.readU8() !== expectedKind
  ) {
    throw new TypeError('Invalid hntrie binary serialization format');
  }
}
