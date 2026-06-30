import {
  walkHostname, splitHostname, labelsToHostname,
  RADIX_SEP,
  trieWalkFindH, trieWalkFind, trieWalkFindCompacted,
  trieCompressNode, trieExpandNode, trieCleanup
} from './_utils.ts';
import { getBit, missingBit, setBit, deleteBit } from 'foxts/bitwise';
import { noop } from 'foxts/noop';

const FLAG_EXACT = 1;
const FLAG_SUBDOMAIN = 2;

interface SmolNode {
  /** key — the label (or radix-compressed labels joined by RADIX_SEP) */
  k: string,
  /** children map — label → child node, null when leaf */
  c: Map<string, SmolNode> | null,
  /** flags — bitmask of FLAG_EXACT / FLAG_SUBDOMAIN */
  f: number
}

function createNode(key: string): SmolNode {
  return { k: key, c: null, f: 0 };
}

// SmolNode has no extra fields to copy during expand
const noopCopyTail = noop as (tail: SmolNode, original: SmolNode) => void;

export class HostnameSmolTrie {
  /** @internal */
  _root: SmolNode = createNode('');
  /** @internal */
  _compacted = false;

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

  get compacted(): boolean {
    return this._compacted;
  }

  // ─── Add ────────────────────────────────────────────────────────────

  add(hostname: string): this {
    if (hostname.codePointAt(0) === 46/* '.' */) {
      return this.addSubdomain(hostname.slice(1));
    }
    this._expandIfCompacted();
    const node = this._walkCreateOrCovered(hostname);
    if (node === null) return this;
    node.f = setBit(node.f, FLAG_EXACT);
    return this;
  }

  addSubdomain(hostname: string): this {
    this._expandIfCompacted();
    const node = this._walkCreateOrCovered(hostname);
    if (node === null) return this;
    if (missingBit(node.f, FLAG_SUBDOMAIN)) {
      node.c = null;
      node.f = setBit(node.f, FLAG_SUBDOMAIN);
      node.f = deleteBit(node.f, FLAG_EXACT);
    }
    return this;
  }

  // ─── Remove ─────────────────────────────────────────────────────────

  remove(hostname: string): boolean {
    this._expandIfCompacted();
    const labels = splitHostname(hostname);
    const node = trieWalkFind(this._root, labels);
    if (!node || missingBit(node.f, FLAG_EXACT)) return false;
    node.f = deleteBit(node.f, FLAG_EXACT);
    trieCleanup(this._root, labels);
    return true;
  }

  removeSubdomain(hostname: string): boolean {
    this._expandIfCompacted();
    const labels = splitHostname(hostname);
    const node = trieWalkFind(this._root, labels);
    if (!node || missingBit(node.f, FLAG_SUBDOMAIN)) return false;
    node.f = deleteBit(node.f, FLAG_SUBDOMAIN);
    trieCleanup(this._root, labels);
    return true;
  }

  delete(hostname: string): boolean {
    if (hostname.codePointAt(0) === 46/* '.' */) {
      return this.removeSubdomain(hostname.slice(1));
    }
    return this.remove(hostname);
  }

  whitelist(hostname: string): void {
    this._expandIfCompacted();
    const isSubdomain = hostname.codePointAt(0) === 46/* '.' */;
    const actual = isSubdomain ? hostname.slice(1) : hostname;
    const labels = splitHostname(actual);
    const node = trieWalkFind(this._root, labels);
    if (!node) return;

    if (isSubdomain) {
      node.f = 0;
      node.c = null;
    } else {
      node.f = deleteBit(node.f, FLAG_EXACT);
      node.f = deleteBit(node.f, FLAG_SUBDOMAIN);
    }

    trieCleanup(this._root, labels);
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

  match(hostname: string): boolean {
    if (this._compacted) {
      const labels = splitHostname(hostname);
      return this._matchCompacted(labels);
    }
    return this._matchUnfrozenH(hostname);
  }

  contains(hostname: string): boolean {
    return this.match(hostname);
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

  // ─── Compact ────────────────────────────────────────────────────────

  compact(): this {
    if (this._compacted) return this;
    trieCompressNode(this._root);
    this._compacted = true;
    return this;
  }

  // ─── Serialization ─────────────────────────────────────────────────

  dump(cb: (hostname: string, includeSubdomain: boolean) => void): void {
    this._walkDump(this._root, [], cb);
  }

  static load(this: void, entries: string[]): HostnameSmolTrie {
    const trie = new HostnameSmolTrie();
    const len = entries.length;
    for (let i = 0; i < len; i++) {
      const entry = entries[i];
      if (entry.codePointAt(0) === 46/* '.' */) {
        trie.addSubdomain(entry.slice(1));
      } else {
        trie.add(entry);
      }
    }
    return trie;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /** @internal */
  private _expandIfCompacted(): void {
    if (this._compacted) {
      trieExpandNode(this._root, createNode, noopCopyTail);
      this._compacted = false;
    }
  }

  /** @internal Walk hostname, creating nodes. Returns null if covered by ancestor subdomain. */
  private _walkCreateOrCovered(hostname: string): SmolNode | null {
    let current = this._root;
    const completed = walkHostname(hostname, (label) => {
      if (current.c === null) {
        current.c = new Map();
      }
      let child = current.c.get(label);
      if (!child) {
        child = createNode(label);
        current.c.set(label, child);
      }
      current = child;
      if (getBit(current.f, FLAG_SUBDOMAIN)) return false;
    });
    return completed ? current : null;
  }

  /** @internal Match hostname string in unfrozen mode. */
  private _matchUnfrozenH(hostname: string): boolean {
    let current = this._root;

    const completed = walkHostname(hostname, (label) => {
      const child = current.c?.get(label);
      if (!child) return false;
      current = child;
      if (getBit(current.f, FLAG_SUBDOMAIN)) return false;
    });

    if (completed) return current.f !== 0;
    return getBit(current.f, FLAG_SUBDOMAIN);
  }

  /** @internal */
  private _matchCompacted(labels: string[]): boolean {
    let current = this._root;
    let i = 0;
    const labelsLen = labels.length;

    while (i < labelsLen) {
      const child = current.c?.get(labels[i]);
      if (!child) return false;

      const parts = child.k.split(RADIX_SEP);
      const partsLen = parts.length;
      for (let p = 0; p < partsLen; p++) {
        if (i >= labelsLen || parts[p] !== labels[i]) return false;
        i++;
      }

      current = child;
      if (getBit(current.f, FLAG_SUBDOMAIN)) return true;
    }

    return current.f !== 0;
  }

  /** @internal */
  private _collectEntries(
    node: SmolNode,
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
    } else if (getBit(node.f, FLAG_EXACT)) {
      result.push(labelsToHostname(parentLabels));
    }

    if (node.c !== null && missingBit(node.f, FLAG_SUBDOMAIN)) {
      for (const child of node.c.values()) {
        this._collectEntries(child, parentLabels, result);
      }
    }

    for (let i = 0; i < partsLen; i++) {
      parentLabels.pop();
    }
  }

  /** @internal */
  private _walkDump(node: SmolNode, labelStack: string[], cb: (hostname: string, includeSubdomain: boolean) => void): void {
    const parts = node.k === '' ? [] : node.k.split(RADIX_SEP);
    const partsLen = parts.length;
    for (let i = 0; i < partsLen; i++) {
      labelStack.push(parts[i]);
    }

    if (getBit(node.f, FLAG_SUBDOMAIN)) {
      cb(labelsToHostname(labelStack), true);
    } else if (getBit(node.f, FLAG_EXACT)) {
      cb(labelsToHostname(labelStack), false);
    }

    if (node.c !== null && missingBit(node.f, FLAG_SUBDOMAIN)) {
      for (const child of node.c.values()) {
        this._walkDump(child, labelStack, cb);
      }
    }

    for (let i = 0; i < partsLen; i++) {
      labelStack.pop();
    }
  }
}
