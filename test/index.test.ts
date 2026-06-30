import { describe, it } from 'mocha';
import { expect } from 'earl';
import { HostnameTrie } from '../src/index.ts';

function collectDump(trie: HostnameTrie): string[] {
  const result: string[] = [];
  trie.dump((hostname, includeSubdomain) => {
    result.push(includeSubdomain ? '.' + hostname : hostname);
  });
  return result;
}

describe('HostnameTrie', () => {
  describe('add / has', () => {
    it('should add and find an exact domain', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      expect(trie.has('example.com')).toEqual(true);
      expect(trie.has('other.com')).toEqual(false);
    });

    it('should not match subdomains for exact add', () => {
      // exact add only matches the domain itself, not its subdomains
      const trie = new HostnameTrie();
      trie.add('example.com');
      expect(trie.has('www.example.com')).toEqual(false);
      expect(trie.has('sub.example.com')).toEqual(false);
    });

    it('should handle trailing dot', () => {
      // trailing dot (FQDN notation) is stripped — treated as same hostname
      const trie = new HostnameTrie();
      trie.add('example.com.');
      expect(trie.has('example.com')).toEqual(true);
      expect(trie.has('example.com.')).toEqual(true);
    });

    it('should store custom values', () => {
      const trie = new HostnameTrie<number>();
      trie.add('example.com', 42);
      expect(trie.match('example.com')).toEqual(42);
    });

    it('should store object values', () => {
      const trie = new HostnameTrie<{ category: string }>();
      trie.add('example.com', { category: 'test' });
      expect(trie.match('example.com')).toEqual({ category: 'test' });
    });

    it('should update value on duplicate add', () => {
      const trie = new HostnameTrie<number>();
      trie.add('example.com', 1);
      trie.add('example.com', 2);
      expect(trie.match('example.com')).toEqual(2);
      expect(trie.size).toEqual(1);
    });

    it('should chain add calls', () => {
      const trie = new HostnameTrie();
      const result = trie.add('a.com').add('b.com');
      expect(result).toEqual(trie);
      expect(trie.size).toEqual(2);
    });
  });

  describe('addSubdomain / hasSubdomain', () => {
    it('should add and find a subdomain entry', () => {
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.hasSubdomain('other.com')).toEqual(false);
    });

    it('should not confuse exact and subdomain entries', () => {
      // exact and subdomain are independent flags on the same node
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.addSubdomain('other.com');
      expect(trie.has('example.com')).toEqual(true);
      expect(trie.hasSubdomain('example.com')).toEqual(false);
      expect(trie.has('other.com')).toEqual(false);
      expect(trie.hasSubdomain('other.com')).toEqual(true);
    });

    it('should allow both exact and subdomain on same hostname', () => {
      // same node can hold both an exact value and a subdomain value
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'exact');
      trie.addSubdomain('example.com', 'subdomain');
      expect(trie.has('example.com')).toEqual(true);
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.size).toEqual(2);
    });
  });

  describe('match', () => {
    it('should match exact domains', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      expect(trie.match('example.com')).toEqual(true);
      expect(trie.match('other.com')).toEqual(null);
    });

    it('should match subdomains via addSubdomain', () => {
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('example.com')).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(true);
      expect(trie.match('mail.example.com')).toEqual(true);
      expect(trie.match('deep.sub.example.com')).toEqual(true);
    });

    it('should not match partial domain names', () => {
      // subdomain matching is label-boundary aware — "notexample.com" is NOT a subdomain of "example.com"
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('notexample.com')).toEqual(null);
      expect(trie.match('myexample.com')).toEqual(null);
    });

    it('should prefer exact match over subdomain match', () => {
      // when both exact and subdomain exist, exact match on the queried hostname wins
      const trie = new HostnameTrie<string>();
      trie.addSubdomain('example.com', 'subdomain');
      trie.add('example.com', 'exact');
      expect(trie.match('example.com')).toEqual('exact');
      // subdomains still fall back to the subdomain marker
      expect(trie.match('www.example.com')).toEqual('subdomain');
    });

    it('should return deepest subdomain match', () => {
      // when multiple subdomain markers exist along the path, the deepest (most specific) one wins
      const trie = new HostnameTrie<string>();
      trie.addSubdomain('com', 'tld');
      trie.addSubdomain('example.com', 'domain');
      expect(trie.match('www.example.com')).toEqual('domain');
      expect(trie.match('other.com')).toEqual('tld');
    });

    it('should handle no match gracefully', () => {
      const trie = new HostnameTrie();
      expect(trie.match('anything.com')).toEqual(null);
    });

    it('should match with exact only when no subdomain matches exist', () => {
      // exact-only entry: parent and children don't match without a subdomain marker
      const trie = new HostnameTrie();
      trie.add('www.example.com');
      expect(trie.match('www.example.com')).toEqual(true);
      expect(trie.match('example.com')).toEqual(null);
      expect(trie.match('sub.www.example.com')).toEqual(null);
    });
  });

  describe('TLD compression', () => {
    it('should handle common TLDs as single nodes', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.add('example.org');
      trie.add('example.net');
      expect(trie.match('example.com')).toEqual(true);
      expect(trie.match('example.org')).toEqual(true);
      expect(trie.match('example.net')).toEqual(true);
    });

    it('should handle multi-part TLDs like co.uk', () => {
      // co.uk is not in TLD list, so "co" and "uk" are stored as separate labels
      const trie = new HostnameTrie();
      trie.add('example.co.uk');
      trie.addSubdomain('bbc.co.uk');
      expect(trie.match('example.co.uk')).toEqual(true);
      expect(trie.match('www.bbc.co.uk')).toEqual(true);
      expect(trie.match('news.bbc.co.uk')).toEqual(true);
      // other.co.uk is not under bbc.co.uk subdomain
      expect(trie.match('other.co.uk')).toEqual(null);
    });

    it('should handle com.au style TLDs', () => {
      const trie = new HostnameTrie();
      trie.add('example.com.au');
      expect(trie.match('example.com.au')).toEqual(true);
      expect(trie.match('example.com')).toEqual(null);
    });

    it('should handle unknown TLDs character by character', () => {
      const trie = new HostnameTrie();
      trie.add('example.unknowntld');
      expect(trie.match('example.unknowntld')).toEqual(true);
    });
  });

  describe('remove', () => {
    it('should remove an exact domain', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      expect(trie.remove('example.com')).toEqual(true);
      expect(trie.has('example.com')).toEqual(false);
      expect(trie.size).toEqual(0);
    });

    it('should return false when removing non-existent domain', () => {
      const trie = new HostnameTrie();
      expect(trie.remove('example.com')).toEqual(false);
    });

    it('should not affect subdomain entry when removing exact', () => {
      // removing exact flag leaves subdomain flag intact on the same node
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.addSubdomain('example.com');
      trie.remove('example.com');
      expect(trie.has('example.com')).toEqual(false);
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(true);
    });

    it('should remove subdomain entry', () => {
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      expect(trie.removeSubdomain('example.com')).toEqual(true);
      expect(trie.hasSubdomain('example.com')).toEqual(false);
      expect(trie.match('www.example.com')).toEqual(null);
    });

    it('should clean up empty nodes after removal', () => {
      // removing the only entry should prune all intermediate nodes back to root
      const trie = new HostnameTrie();
      trie.add('deep.sub.example.com');
      trie.remove('deep.sub.example.com');
      expect(trie._root.c).toEqual(null);
    });

    it('should not clean up nodes that still have other children', () => {
      // sibling entries keep shared parent nodes alive
      const trie = new HostnameTrie();
      trie.add('a.example.com');
      trie.add('b.example.com');
      trie.remove('a.example.com');
      expect(trie.has('b.example.com')).toEqual(true);
      expect(trie.size).toEqual(1);
    });

    it('should update size correctly', () => {
      const trie = new HostnameTrie();
      trie.add('a.com');
      trie.add('b.com');
      trie.addSubdomain('c.com');
      expect(trie.size).toEqual(3);
      trie.remove('a.com');
      expect(trie.size).toEqual(2);
      trie.removeSubdomain('c.com');
      expect(trie.size).toEqual(1);
    });
  });

  describe('compact', () => {
    it('should compact and still match correctly', () => {
      const trie = new HostnameTrie<string>();
      trie.add('www.example.com', 'exact');
      trie.addSubdomain('example.com', 'subdomain');
      trie.compact();

      expect(trie.compacted).toEqual(true);
      expect(trie.match('www.example.com')).toEqual('exact');
      expect(trie.match('other.example.com')).toEqual('subdomain');
      expect(trie.match('example.com')).toEqual('subdomain');
      expect(trie.match('other.com')).toEqual(null);
    });

    it('should auto-expand on mutation when compacted', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.compact();
      expect(trie.compacted).toEqual(true);

      trie.add('other.com');
      expect(trie.compacted).toEqual(false);
      expect(trie.match('other.com')).toEqual(true);
      expect(trie.match('example.com')).toEqual(true);
    });

    it('should auto-expand on remove when compacted', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.add('other.com');
      trie.compact();

      expect(trie.remove('example.com')).toEqual(true);
      expect(trie.compacted).toEqual(false);
      expect(trie.match('example.com')).toEqual(null);
      expect(trie.match('other.com')).toEqual(true);
    });

    it('should compress single-child chains', () => {
      // radix compression merges single-child chains: com → example → sub → deep becomes one node
      const trie = new HostnameTrie();
      trie.add('deep.sub.example.com');
      trie.compact();

      // 'com' is index 0 in the TLD compression table → ID '0'
      const comNode = trie._root.c!.get('0')!;
      expect(comNode.k.includes('|')).toEqual(true);
    });

    it('should not compress nodes with data', () => {
      // nodes with flags (exact/subdomain) are merge boundaries — can't be collapsed
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      trie.add('www.example.com');
      trie.compact();

      expect(trie.match('www.example.com')).toEqual(true);
      // subdomain fallback still works across compressed nodes
      expect(trie.match('other.example.com')).toEqual(true);
    });

    it('should not compress nodes with multiple children', () => {
      // branching nodes can't be merged — they need separate children
      const trie = new HostnameTrie();
      trie.add('a.example.com');
      trie.add('b.example.com');
      trie.compact();

      expect(trie.match('a.example.com')).toEqual(true);
      expect(trie.match('b.example.com')).toEqual(true);
    });

    it('compact should be idempotent', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.compact();
      trie.compact();
      expect(trie.match('example.com')).toEqual(true);
    });

    it('should handle compact-edit-compact cycle', () => {
      const trie = new HostnameTrie();
      trie.add('a.example.com');
      trie.compact();
      expect(trie.match('a.example.com')).toEqual(true);

      trie.add('b.example.com');
      expect(trie.compacted).toEqual(false);
      trie.compact();

      expect(trie.match('a.example.com')).toEqual(true);
      expect(trie.match('b.example.com')).toEqual(true);
    });

    it('should handle has/hasSubdomain in compacted mode', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.addSubdomain('other.com');
      trie.compact();

      expect(trie.has('example.com')).toEqual(true);
      expect(trie.hasSubdomain('other.com')).toEqual(true);
      expect(trie.has('other.com')).toEqual(false);
      expect(trie.hasSubdomain('example.com')).toEqual(false);
    });

    it('should handle compacted subdomain matching across compressed nodes', () => {
      // subdomain fallback must work even when intermediate labels are radix-compressed
      const trie = new HostnameTrie<string>();
      trie.addSubdomain('example.com', 'top');
      trie.add('deep.sub.example.com', 'leaf');
      trie.compact();

      // exact match wins for the full path
      expect(trie.match('deep.sub.example.com')).toEqual('leaf');
      // partial path through compressed node falls back to subdomain
      expect(trie.match('other.sub.example.com')).toEqual('top');
      expect(trie.match('www.example.com')).toEqual('top');
    });
  });

  describe('serialize / deserialize', () => {
    it('should round-trip a simple trie', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.addSubdomain('google.com');
      trie.add('blog.example.com');

      const serialized = trie.serialize();

      const restored = HostnameTrie.deserialize(serialized);

      expect(restored.match('example.com')).toEqual(true);
      expect(restored.match('www.google.com')).toEqual(true);
      expect(restored.match('other.com')).toEqual(null);
      expect(restored.size).toEqual(3);
    });

    it('should round-trip with custom values', () => {
      const trie = new HostnameTrie<number>();
      trie.add('a.com', 1);
      trie.add('b.com', 2);
      trie.addSubdomain('c.com', 3);

      const serialized = trie.serialize();
      const restored = HostnameTrie.deserialize<number>(serialized);

      expect(restored.match('a.com')).toEqual(1);
      expect(restored.match('b.com')).toEqual(2);
      expect(restored.match('www.c.com')).toEqual(3);
    });

    it('should round-trip with custom serialization functions', () => {
      const trie = new HostnameTrie<{ id: number, name: string }>();
      trie.add('example.com', { id: 1, name: 'test' });

      const serialized = trie.serialize(v => `${v.id}:${v.name}`);
      const restored = HostnameTrie.deserialize<{ id: number, name: string }>(
        serialized,
        s => {
          const [id, name] = s.split(':');
          return { id: Number(id), name };
        }
      );

      expect(restored.match('example.com')).toEqual({ id: 1, name: 'test' });
    });

    it('should round-trip a compacted trie', () => {
      // serialization preserves radix-compressed state; deserialize detects it
      const trie = new HostnameTrie();
      trie.add('deep.sub.example.com');
      trie.addSubdomain('other.com');
      trie.compact();

      const serialized = trie.serialize();
      const restored = HostnameTrie.deserialize(serialized);

      expect(restored.compacted).toEqual(true);
      expect(restored.match('deep.sub.example.com')).toEqual(true);
      expect(restored.match('www.other.com')).toEqual(true);
    });

    it('should produce valid JSON via toJSON', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');

      const json = JSON.stringify({ trie });
      const parsed = JSON.parse(json);
      const restored = HostnameTrie.fromJSON(parsed.trie);

      expect(restored.match('example.com')).toEqual(true);
    });

    it('should throw on invalid format', () => {
      expect(() => HostnameTrie.deserialize('invalid')).toThrow();
    });

    it('should handle empty trie', () => {
      const trie = new HostnameTrie();
      const serialized = trie.serialize();
      const restored = HostnameTrie.deserialize(serialized);
      expect(restored.size).toEqual(0);
      expect(restored.match('anything.com')).toEqual(null);
    });

    it('should round-trip boolean true values compactly', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      const serialized = trie.serialize();
      // Boolean true should not be serialized as JSON — just flags
      expect(serialized).not.toInclude('"true"');
      expect(serialized).not.toInclude('true');
    });
  });

  describe('iteration', () => {
    it('should iterate all entries', () => {
      const trie = new HostnameTrie<string>();
      trie.add('a.com', 'v1');
      trie.addSubdomain('b.com', 'v2');
      trie.add('c.org', 'v3');

      const entries = [...trie];
      expect(entries.length).toEqual(3);

      const map = new Map(entries.map(([h, v, t]) => [`${t}:${h}`, v]));
      expect(map.get('exact:a.com')).toEqual('v1');
      expect(map.get('subdomain:b.com')).toEqual('v2');
      expect(map.get('exact:c.org')).toEqual('v3');
    });

    it('should iterate compacted trie', () => {
      const trie = new HostnameTrie();
      trie.add('www.example.com');
      trie.addSubdomain('other.com');
      trie.compact();

      const entries = [...trie];
      expect(entries.length).toEqual(2);
    });

    it('should iterate entries with both exact and subdomain on same host', () => {
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'exact');
      trie.addSubdomain('example.com', 'sub');

      const entries = [...trie];
      expect(entries.length).toEqual(2);

      const types = new Set(entries.map((t) => t[2]));
      expect(types.has('exact')).toEqual(true);
      expect(types.has('subdomain')).toEqual(true);
    });

    it('should iterate empty trie', () => {
      const trie = new HostnameTrie();
      const entries = [...trie];
      expect(entries.length).toEqual(0);
    });
  });

  describe('size', () => {
    it('should start at 0', () => {
      const trie = new HostnameTrie();
      expect(trie.size).toEqual(0);
    });

    it('should count exact and subdomain separately', () => {
      // same hostname with both exact and subdomain counts as 2 entries
      const trie = new HostnameTrie();
      trie.add('example.com');
      expect(trie.size).toEqual(1);
      trie.addSubdomain('example.com');
      expect(trie.size).toEqual(2);
    });

    it('should not increment on duplicate adds', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      // eslint-disable-next-line sukka/no-element-overwrite -- trie test
      trie.add('example.com');
      expect(trie.size).toEqual(1);
    });
  });

  describe('edge cases', () => {
    it('should handle single-label hostname', () => {
      const trie = new HostnameTrie();
      trie.add('localhost');
      expect(trie.match('localhost')).toEqual(true);
      expect(trie.match('other')).toEqual(null);
    });

    it('should handle TLD-only entry', () => {
      // subdomain on a TLD matches everything under that TLD
      const trie = new HostnameTrie();
      trie.addSubdomain('com');
      expect(trie.match('anything.com')).toEqual(true);
      expect(trie.match('com')).toEqual(true);
      expect(trie.match('anything.org')).toEqual(null);
    });

    it('should handle many domains under same TLD', () => {
      const trie = new HostnameTrie<number>();
      for (let i = 0; i < 100; i++) {
        trie.add(`domain${i}.com`, i);
      }
      for (let i = 0; i < 100; i++) {
        expect(trie.match(`domain${i}.com`)).toEqual(i);
      }
      expect(trie.size).toEqual(100);
    });

    it('should handle deeply nested subdomains', () => {
      const trie = new HostnameTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('a.b.c.d.e.f.example.com')).toEqual(true);
    });

    it('should differentiate domains that share prefixes', () => {
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'a');
      trie.add('example.org', 'b');
      trie.add('example.net', 'c');
      expect(trie.match('example.com')).toEqual('a');
      expect(trie.match('example.org')).toEqual('b');
      expect(trie.match('example.net')).toEqual('c');
    });

    it('should handle multi-part TLD domains correctly', () => {
      const trie = new HostnameTrie();
      trie.add('gov.uk');
      trie.addSubdomain('service.gov.uk');
      expect(trie.match('gov.uk')).toEqual(true);
      expect(trie.match('www.service.gov.uk')).toEqual(true);
      expect(trie.match('other.gov.uk')).toEqual(null);
    });
  });

  describe('constructor', () => {
    it('should create from array', () => {
      const trie = new HostnameTrie(['skk.moe', 'blog.skk.moe']);
      expect(trie.size).toEqual(2);
      expect(trie.has('skk.moe')).toEqual(true);
    });

    it('should create from Set', () => {
      const trie = new HostnameTrie(new Set(['skk.moe', 'example.com']));
      expect(trie.size).toEqual(2);
      expect(trie.has('skk.moe')).toEqual(true);
    });

    it('should handle null', () => {
      const trie = new HostnameTrie(null);
      expect(trie.size).toEqual(0);
    });

    it('should handle dot-prefix in constructor', () => {
      // dot-prefix in input routes to addSubdomain, bare hostname routes to add
      const trie = new HostnameTrie(['.skk.moe', 'noc.one']);
      expect(trie.hasSubdomain('skk.moe')).toEqual(true);
      expect(trie.has('noc.one')).toEqual(true);
    });
  });

  describe('dot-prefix convention', () => {
    it('should route dot-prefix add to addSubdomain', () => {
      const trie = new HostnameTrie();
      trie.add('.skk.moe');
      expect(trie.hasSubdomain('skk.moe')).toEqual(true);
      expect(trie.has('skk.moe')).toEqual(false);
    });
  });

  describe('delete', () => {
    it('should delete exact entries', () => {
      const trie = new HostnameTrie();
      trie.add('skk.moe');
      trie.add('blog.skk.moe');
      trie.add('example.com');
      trie.add('moe.sb');

      expect(trie.delete('no-match.com')).toEqual(false);
      expect(trie.delete('example.org')).toEqual(false);

      expect(trie.delete('skk.moe')).toEqual(true);
      expect(trie.has('skk.moe')).toEqual(false);
      expect(trie.has('moe.sb')).toEqual(true);

      expect(trie.size).toEqual(3);

      expect(trie.delete('example.com')).toEqual(true);
      expect(trie.size).toEqual(2);
      expect(trie.delete('moe.sb')).toEqual(true);
      expect(trie.size).toEqual(1);
    });

    it('should delete subdomain entries with dot prefix', () => {
      const trie = new HostnameTrie();
      trie.add('.skk.moe');
      expect(trie.delete('.skk.moe')).toEqual(true);
      expect(trie.hasSubdomain('skk.moe')).toEqual(false);
    });
  });

  describe('find', () => {
    it('should find entries under a hostname', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.add('blog.example.com');
      trie.add('cdn.example.com');
      trie.add('example.org');

      expect(trie.find('example.com')).toEqual(['example.com', 'blog.example.com', 'cdn.example.com']);
      expect(trie.find('com')).toEqual(['example.com', 'blog.example.com', 'cdn.example.com']);
      expect(trie.find('.example.com')).toEqual(['blog.example.com', 'cdn.example.com']);
      expect(trie.find('org')).toEqual(['example.org']);
      expect(trie.find('example.net')).toEqual([]);
    });
  });

  describe('dump', () => {
    it('should dump all entries', () => {
      const trie = new HostnameTrie();
      trie.add('example.com');
      trie.add('blog.example.com');
      trie.add('cdn.example.com');
      trie.add('example.org');

      expect(collectDump(trie)).toEqual(['example.com', 'blog.example.com', 'cdn.example.com', 'example.org']);
    });

    it('should dump subdomain entries with includeSubdomain flag', () => {
      const trie = new HostnameTrie(['.skk.moe', 'noc.one']);
      // dump exposes (hostname, includeSubdomain) — no dot prefix leaking
      const entries: Array<[string, boolean]> = [];
      trie.dump((hostname, includeSubdomain) => { entries.push([hostname, includeSubdomain]); });
      expect(entries).toEqual([
        ['skk.moe', true],
        ['noc.one', false]
      ]);
    });

    it('should group domains sharing the longest suffix together via DFS', () => {
      // DFS traversal naturally groups domains by shared suffix:
      // a.com → www.a.com → blog.www.a.com (share www.a.com suffix)
      // then ww.a.com (sibling under a.com), then cdn.b.com (different branch)
      const trie = new HostnameTrie();
      trie.add('blog.www.a.com');
      trie.add('www.a.com');
      trie.add('ww.a.com');
      trie.add('a.com');
      trie.add('cdn.b.com');

      expect(collectDump(trie)).toEqual([
        'a.com',
        'www.a.com',
        'blog.www.a.com',
        'ww.a.com',
        'cdn.b.com'
      ]);
    });

    it('should group subdomains with their parent before moving to siblings', () => {
      const trie = new HostnameTrie();
      trie.addSubdomain('skk.moe');
      trie.add('blog.skk.moe');
      trie.add('noc.one');
      trie.add('cdn.noc.one');
      trie.add('api.noc.one');
      trie.add('example.com');

      expect(collectDump(trie)).toEqual([
        '.skk.moe',
        'blog.skk.moe',
        'noc.one',
        'cdn.noc.one',
        'api.noc.one',
        'example.com'
      ]);
    });
  });

  describe('userscript per-domain preferences', () => {
    it('should store and retrieve per-domain config objects', () => {
      const trie = new HostnameTrie<{ darkMode: boolean, fontSize: number }>();
      trie.add('example.com', { darkMode: true, fontSize: 14 });
      // subdomain acts as fallback for all *.google.com
      trie.addSubdomain('google.com', { darkMode: false, fontSize: 16 });
      // longest (most specific) hostname has priority over subdomain fallback
      trie.add('mail.google.com', { darkMode: true, fontSize: 12 });

      expect(trie.match('example.com')).toEqual({ darkMode: true, fontSize: 14 });
      // exact match on mail.google.com wins over .google.com subdomain
      expect(trie.match('mail.google.com')).toEqual({ darkMode: true, fontSize: 12 });
      // no exact match, falls back to .google.com subdomain
      expect(trie.match('drive.google.com')).toEqual({ darkMode: false, fontSize: 16 });
      // no match at all
      expect(trie.match('unknown.com')).toEqual(null);
    });

    it('should allow editing after compact without explicit expand', () => {
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'block');
      trie.addSubdomain('ads.com', 'hide');
      trie.compact();

      expect(trie.compacted).toEqual(true);
      expect(trie.match('example.com')).toEqual('block');
      expect(trie.match('tracker.ads.com')).toEqual('hide');

      // auto-expands radix nodes on mutation, no explicit expand needed
      trie.add('newsite.org', 'allow');
      expect(trie.compacted).toEqual(false);
      expect(trie.match('newsite.org')).toEqual('allow');
      // existing entries still intact after auto-expand
      expect(trie.match('example.com')).toEqual('block');
      expect(trie.match('tracker.ads.com')).toEqual('hide');
    });

    it('should support compact-edit-compact cycle for storage', () => {
      const trie = new HostnameTrie<number>();
      trie.add('a.com', 1);
      trie.add('b.com', 2);
      trie.compact();

      // user edits: add new, remove old — auto-expands, does NOT auto-recompact
      trie.add('c.com', 3);
      trie.remove('a.com');
      // user explicitly re-compacts when ready (e.g. before storage)
      trie.compact();

      expect(trie.compacted).toEqual(true);
      expect(trie.match('a.com')).toEqual(null);
      expect(trie.match('b.com')).toEqual(2);
      expect(trie.match('c.com')).toEqual(3);
      expect(trie.size).toEqual(2);
    });

    it('should update existing domain preference in-place', () => {
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'v1');
      trie.compact();

      // overwrite value for same domain after compact
      trie.add('example.com', 'v2');
      expect(trie.match('example.com')).toEqual('v2');
      expect(trie.size).toEqual(1);
    });
  });

  describe('empty string', () => {
    it('should add and find empty hostname', () => {
      const trie = new HostnameTrie();
      trie.add('');
      expect(trie.has('')).toEqual(true);
    });
  });

  describe('serialization snapshot', () => {
    // Pin serialization format so TLD ID encoding changes are caught
    it('should match serialize snapshot for uncompacted trie', function () {
      const trie = new HostnameTrie<string>();
      // Cover several TLDs across frequency tiers
      trie.add('example.com', 'v1');
      trie.addSubdomain('cdn.net', 'v2');
      trie.add('test.io', 'v3');
      trie.add('site.au', 'v4');
      trie.add('blog.de', 'v5');
      trie.addSubdomain('api.xyz', 'v6');
      trie.add('deep.sub.example.com', 'v7');
      // Unknown TLD — no compression
      trie.add('foo.unknown', 'v8');

      expect(trie.serialize()).toMatchSnapshot(this);
    });

    it('should match serialize snapshot for compacted trie', function () {
      const trie = new HostnameTrie<string>();
      trie.add('example.com', 'v1');
      trie.addSubdomain('cdn.net', 'v2');
      trie.add('test.io', 'v3');
      trie.add('site.au', 'v4');
      trie.add('blog.de', 'v5');
      trie.addSubdomain('api.xyz', 'v6');
      trie.add('deep.sub.example.com', 'v7');
      trie.add('foo.unknown', 'v8');
      trie.compact();

      expect(trie.serialize()).toMatchSnapshot(this);
    });
  });
});
