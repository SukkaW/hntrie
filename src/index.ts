import {
  walkHostname, splitHostname, labelsToHostname,
  RADIX_SEP,
  trieWalkFindH, trieWalkFind, trieWalkFindCompacted,
  trieCompressNode, trieExpandNode, trieCleanup
} from './_utils.ts';
import { getBit, missingBit, setBit, deleteBit } from 'foxts/bitwise';
import { fastStringArrayJoin } from 'foxts/fast-string-array-join';

const FLAG_EXACT = 1;
const FLAG_SUBDOMAIN = 2;

const SEP_NODE = '\n';
const SEP_FIELD = '\t';
const SERIAL_HEADER = 'hntrie:1';

interface TrieNode<T> {
  /** key — the label (or radix-compressed labels joined by RADIX_SEP) */
  k: string,
  /** children map — label → child node, null when leaf */
  c: Map<string, TrieNode<T>> | null,
  /** flags — bitmask of FLAG_EXACT / FLAG_SUBDOMAIN */
  f: number,
  /** exact-match value */
  e: T | undefined,
  /** subdomain-match value */
  s: T | undefined
}

function createNode<T>(key: string): TrieNode<T> {
  return { k: key, c: null, f: 0, e: undefined, s: undefined };
}

function copyTrieNodeTail<T>(tail: TrieNode<T>, original: TrieNode<T>): void {
  tail.e = original.e;
  tail.s = original.s;
}

function hasCompressedKeys<T>(node: TrieNode<T>): boolean {
  if (node.k.includes(RADIX_SEP)) return true;
  if (node.c !== null) {
    for (const child of node.c.values()) {
      if (hasCompressedKeys(child)) return true;
    }
  }
  return false;
}

export class HostnameTrie<T = boolean> {
  /** @internal */
  _root: TrieNode<T> = createNode('');
  /** @internal */
  _compacted = false;
  /** @internal */
  _size = 0;

  constructor(from?: Iterable<string> | null) {
    if (from) {
      for (const entry of from) {
        if (entry.codePointAt(0) === 46/* '.' */) {
          this.addSubdomain(entry.slice(1));
        } else {
          this.add(entry);
        }
      }
    }
  }

  get size(): number {
    return this._size;
  }

  get compacted(): boolean {
    return this._compacted;
  }

  // ─── Add ────────────────────────────────────────────────────────────

  add(hostname: string, value: T = true as T): this {
    if (hostname.codePointAt(0) === 46/* '.' */) {
      return this.addSubdomain(hostname.slice(1), value);
    }
    this._expandIfCompacted();
    const node = this._walkCreateH(hostname);
    if (missingBit(node.f, FLAG_EXACT)) this._size++;
    node.f = setBit(node.f, FLAG_EXACT);
    node.e = value;
    return this;
  }

  addSubdomain(hostname: string, value: T = true as T): this {
    this._expandIfCompacted();
    const node = this._walkCreateH(hostname);
    if (missingBit(node.f, FLAG_SUBDOMAIN)) this._size++;
    node.f = setBit(node.f, FLAG_SUBDOMAIN);
    node.s = value;
    return this;
  }

  // ─── Remove ─────────────────────────────────────────────────────────

  remove(hostname: string): boolean {
    this._expandIfCompacted();
    const labels = splitHostname(hostname);
    const node = trieWalkFind(this._root, labels);
    if (!node || missingBit(node.f, FLAG_EXACT)) return false;
    node.f = deleteBit(node.f, FLAG_EXACT);
    node.e = undefined;
    this._size--;
    trieCleanup(this._root, labels);
    return true;
  }

  removeSubdomain(hostname: string): boolean {
    this._expandIfCompacted();
    const labels = splitHostname(hostname);
    const node = trieWalkFind(this._root, labels);
    if (!node || missingBit(node.f, FLAG_SUBDOMAIN)) return false;
    node.f = deleteBit(node.f, FLAG_SUBDOMAIN);
    node.s = undefined;
    this._size--;
    trieCleanup(this._root, labels);
    return true;
  }

  delete(hostname: string): boolean {
    if (hostname.codePointAt(0) === 46/* '.' */) {
      return this.removeSubdomain(hostname.slice(1));
    }
    return this.remove(hostname);
  }

  // ─── Query ──────────────────────────────────────────────────────────

  has(hostname: string): boolean {
    if (this._compacted) {
      const labels = splitHostname(hostname);
      return getBit(trieWalkFindCompacted(this._root, labels)?.f ?? 0, FLAG_EXACT);
    }
    return getBit(trieWalkFindH(this._root, hostname)?.f ?? 0, FLAG_EXACT);
  }

  hasSubdomain(hostname: string): boolean {
    if (this._compacted) {
      const labels = splitHostname(hostname);
      return getBit(trieWalkFindCompacted(this._root, labels)?.f ?? 0, FLAG_SUBDOMAIN);
    }
    return getBit(trieWalkFindH(this._root, hostname)?.f ?? 0, FLAG_SUBDOMAIN);
  }

  match(hostname: string): T | null {
    if (this._compacted) {
      const labels = splitHostname(hostname);
      return this._matchCompacted(labels);
    }
    return this._matchUnfrozenH(hostname);
  }

  find(prefix: string): string[] {
    // a compacted node's key may join multiple labels (RADIX_SEP), so a prefix
    // query can land mid-node — expand first so every node is one label deep,
    // then restore compaction afterward so the caller's chosen state sticks
    const wasCompacted = this._compacted;
    this._expandIfCompacted();
    const isSubdomainQuery = prefix.codePointAt(0) === 46/* '.' */;
    const hostname = isSubdomainQuery ? prefix.slice(1) : prefix;
    const labels = splitHostname(hostname);
    const node = trieWalkFind(this._root, labels);
    const result: string[] = [];

    if (!node) {
      if (wasCompacted) this.compact();
      return result;
    }

    if (isSubdomainQuery) {
      if (getBit(node.f, FLAG_SUBDOMAIN)) {
        result.push('.' + hostname);
      }
      if (node.c !== null) {
        for (const child of node.c.values()) {
          this._collectEntries(child, labels, result);
        }
      }
    } else {
      this._collectEntries(node, labels.slice(0, -1), result);
    }

    if (wasCompacted) this.compact();

    return result;
  }

  dump(cb: (hostname: string, includeSubdomain: boolean, value: T) => void): void {
    this._walkDump(this._root, [], cb);
  }

  // ─── Compact ────────────────────────────────────────────────────────

  compact(): this {
    if (this._compacted) return this;
    trieCompressNode(this._root);
    this._compacted = true;
    return this;
  }

  // ─── Serialization ─────────────────────────────────────────────────

  serialize(valueToString?: (value: T) => string): string {
    const lines: string[] = [SERIAL_HEADER];
    this._serializeNode(this._root, lines, valueToString);
    return fastStringArrayJoin(lines, SEP_NODE);
  }

  static deserialize<T = boolean>(
    this: void,
    data: string,
    valueFromString?: (s: string) => T
  ): HostnameTrie<T> {
    const trie = new HostnameTrie<T>();
    const lines = data.split(SEP_NODE);

    if (lines[0] !== SERIAL_HEADER) {
      throw new Error('Invalid hntrie serialization format');
    }

    let size = 0;
    const stack: Array<[TrieNode<T>, number]> = [[trie._root, -1]];

    const linesLen = lines.length;
    for (let i = 1; i < linesLen; i++) {
      const line = lines[i];
      if (line.length === 0) continue;

      const fields = line.split(SEP_FIELD);
      const depth = Number.parseInt(fields[0], 36);
      const key = fields[1];
      const flags = Number.parseInt(fields[2], 36);
      const eVal = fields[3] || '';
      const sVal = fields[4] || '';

      const node = createNode<T>(key);
      node.f = flags;

      if (getBit(flags, FLAG_EXACT)) {
        node.e = eVal
          ? (valueFromString ? valueFromString(eVal) : JSON.parse(eVal) as T)
          : true as T;
        size++;
      }
      if (getBit(flags, FLAG_SUBDOMAIN)) {
        node.s = sVal
          ? (valueFromString ? valueFromString(sVal) : JSON.parse(sVal) as T)
          : true as T;
        size++;
      }

      while (stack.length > 1 && stack[stack.length - 1][1] >= depth) {
        stack.pop();
      }

      const parent = stack[stack.length - 1][0];
      if (parent.c === null) parent.c = new Map();
      const mapKey = key.includes(RADIX_SEP) ? key.slice(0, key.indexOf(RADIX_SEP)) : key;
      parent.c.set(mapKey, node);

      stack.push([node, depth]);
    }

    trie._size = size;
    trie._compacted = hasCompressedKeys(trie._root);
    return trie;
  }

  toJSON(): string {
    return this.serialize();
  }

  static fromJSON<T = boolean>(
    this: void,
    data: string,
    valueFromString?: (s: string) => T
  ): HostnameTrie<T> {
    // eslint-disable-next-line sukka/unicorn/class-reference-in-static-methods -- static factory
    return HostnameTrie.deserialize(data, valueFromString);
  }

  // ─── Iteration ─────────────────────────────────────────────────────

  *[Symbol.iterator](): Generator<[string, T, 'exact' | 'subdomain']> {
    yield *this._iterateNode(this._root, []);
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /** @internal */
  private _expandIfCompacted(): void {
    if (this._compacted) {
      trieExpandNode(this._root, createNode, copyTrieNodeTail);
      this._compacted = false;
    }
  }

  /** @internal Walk hostname string, creating nodes as needed. */
  private _walkCreateH(hostname: string): TrieNode<T> {
    let current = this._root;
    walkHostname(hostname, (label) => {
      if (current.c === null) {
        current.c = new Map();
      }
      let child = current.c.get(label);
      if (!child) {
        child = createNode(label);
        current.c.set(label, child);
      }
      current = child;
    });
    return current;
  }

  /** @internal Match hostname string in unfrozen mode. */
  private _matchUnfrozenH(hostname: string): T | null {
    let current = this._root;
    let lastSubdomainMatch: T | null = null; // eslint-disable-line sukka/no-single-return -- tracks deepest subdomain match across walk

    const completed = walkHostname(hostname, (label) => {
      const child = current.c?.get(label);
      if (!child) return false;
      current = child;
      if (getBit(current.f, FLAG_SUBDOMAIN)) {
        lastSubdomainMatch = current.s!; // eslint-disable-line sukka/no-single-return -- updates deepest match during walk
      }
    });

    if (completed && getBit(current.f, FLAG_EXACT)) return current.e!;
    return lastSubdomainMatch; // eslint-disable-line sukka/no-single-return -- fallback to deepest subdomain match
  }

  /** @internal Match in compacted (radix) mode with subdomain tracking. */
  private _matchCompacted(labels: string[]): T | null {
    let current = this._root;
    let lastSubdomainMatch: T | null = null;
    let i = 0;
    const labelsLen = labels.length;

    while (i < labelsLen) {
      const child = current.c?.get(labels[i]);
      if (!child) return lastSubdomainMatch;

      const parts = child.k.split(RADIX_SEP);
      const partsLen = parts.length;
      for (let p = 0; p < partsLen; p++) {
        if (i >= labelsLen || parts[p] !== labels[i]) {
          return lastSubdomainMatch;
        }
        i++;
      }

      current = child;
      if (getBit(current.f, FLAG_SUBDOMAIN)) {
        lastSubdomainMatch = current.s!;
      }
    }

    if (getBit(current.f, FLAG_EXACT)) return current.e!;
    return lastSubdomainMatch;
  }

  /** @internal */
  private _serializeNode(
    node: TrieNode<T>,
    lines: string[],
    valueToString: ((value: T) => string) | undefined,
    depth = -1
  ): void {
    if (depth >= 0) {
      let eStr = '';
      let sStr = '';

      if (getBit(node.f, FLAG_EXACT) && (node.e as unknown) !== true) {
        eStr = valueToString ? valueToString(node.e!) : JSON.stringify(node.e);
      }
      if (getBit(node.f, FLAG_SUBDOMAIN) && (node.s as unknown) !== true) {
        sStr = valueToString ? valueToString(node.s!) : JSON.stringify(node.s);
      }

      let line = depth.toString(36) + SEP_FIELD + node.k + SEP_FIELD + node.f.toString(36);
      if (eStr || sStr) {
        line += SEP_FIELD + eStr;
        if (sStr) line += SEP_FIELD + sStr;
      }
      lines.push(line);
    }

    if (node.c !== null) {
      for (const child of node.c.values()) {
        this._serializeNode(child, lines, valueToString, depth + 1);
      }
    }
  }

  /** @internal */
  private *_iterateNode(
    node: TrieNode<T>,
    labelStack: string[]
  ): Generator<[string, T, 'exact' | 'subdomain']> {
    const parts = node.k === '' ? [] : node.k.split(RADIX_SEP);
    const partsLen = parts.length;
    for (let i = 0; i < partsLen; i++) {
      labelStack.push(parts[i]);
    }

    if (getBit(node.f, FLAG_EXACT)) {
      yield [labelsToHostname(labelStack), node.e!, 'exact'];
    }
    if (getBit(node.f, FLAG_SUBDOMAIN)) {
      yield [labelsToHostname(labelStack), node.s!, 'subdomain'];
    }

    if (node.c !== null) {
      for (const child of node.c.values()) {
        yield *this._iterateNode(child, labelStack);
      }
    }

    for (let i = 0; i < partsLen; i++) {
      labelStack.pop();
    }
  }

  /** @internal */
  private _collectEntries(
    node: TrieNode<T>,
    parentLabels: string[],
    result: string[]
  ): void {
    const parts = node.k === '' ? [] : node.k.split(RADIX_SEP);
    const partsLen = parts.length;
    for (let i = 0; i < partsLen; i++) {
      parentLabels.push(parts[i]);
    }

    if (getBit(node.f, FLAG_SUBDOMAIN)) {
      result.push('.' + labelsToHostname(parentLabels));
    }
    if (getBit(node.f, FLAG_EXACT)) {
      result.push(labelsToHostname(parentLabels));
    }

    if (node.c !== null) {
      for (const child of node.c.values()) {
        this._collectEntries(child, parentLabels, result);
      }
    }

    for (let i = 0; i < partsLen; i++) {
      parentLabels.pop();
    }
  }

  /** @internal */
  private _walkDump(
    node: TrieNode<T>,
    labelStack: string[],
    cb: (hostname: string, includeSubdomain: boolean, value: T) => void
  ): void {
    const parts = node.k === '' ? [] : node.k.split(RADIX_SEP);
    const partsLen = parts.length;
    for (let i = 0; i < partsLen; i++) {
      labelStack.push(parts[i]);
    }

    if (getBit(node.f, FLAG_SUBDOMAIN)) {
      cb(labelsToHostname(labelStack), true, node.s!);
    }
    if (getBit(node.f, FLAG_EXACT)) {
      cb(labelsToHostname(labelStack), false, node.e!);
    }

    if (node.c !== null) {
      for (const child of node.c.values()) {
        this._walkDump(child, labelStack, cb);
      }
    }

    for (let i = 0; i < partsLen; i++) {
      labelStack.pop();
    }
  }
}
