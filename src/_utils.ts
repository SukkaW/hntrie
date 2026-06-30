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
