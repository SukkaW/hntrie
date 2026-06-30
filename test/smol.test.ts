import { describe, it } from 'mocha';
import { expect } from 'earl';
import { HostnameSmolTrie } from '../src/smol.ts';

function collectDump(trie: HostnameSmolTrie): string[] {
  const result: string[] = [];
  trie.dump((hostname, includeSubdomain) => {
    result.push(includeSubdomain ? '.' + hostname : hostname);
  });
  return result;
}

describe('SmolTrie', () => {
  describe('add / has', () => {
    it('should add and find an exact domain', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      expect(trie.has('example.com')).toEqual(true);
      expect(trie.has('other.com')).toEqual(false);
    });

    it('should not match subdomains for exact add', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      expect(trie.has('www.example.com')).toEqual(false);
      expect(trie.match('www.example.com')).toEqual(false);
    });

    it('should chain add calls', () => {
      const trie = new HostnameSmolTrie();
      const result = trie.add('a.com').add('b.com');
      expect(result).toEqual(trie);
      expect(trie.has('a.com')).toEqual(true);
      expect(trie.has('b.com')).toEqual(true);
    });
  });

  describe('addSubdomain / hasSubdomain', () => {
    it('should add and find a subdomain entry', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(true);
      expect(trie.match('deep.sub.example.com')).toEqual(true);
    });

    it('should match the domain itself with subdomain entry', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('example.com')).toEqual(true);
    });
  });

  describe('deduplication / pruning', () => {
    it('should drop exact child when parent gets subdomain marker', () => {
      // subdomain marker on parent makes all children redundant — prune them
      const trie = new HostnameSmolTrie();
      trie.add('www.example.com');

      trie.addSubdomain('example.com');
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      // exact entry pruned, but still matched via subdomain fallback
      expect(trie.has('www.example.com')).toEqual(false);
      expect(trie.match('www.example.com')).toEqual(true);
    });

    it('should drop multiple children when parent gets subdomain marker', () => {
      // all children (exact and subdomain) under the parent are pruned
      const trie = new HostnameSmolTrie();
      trie.add('a.example.com');
      trie.add('b.example.com');
      trie.add('c.example.com');
      trie.addSubdomain('sub.example.com');

      // adding subdomain on parent collapses everything underneath
      trie.addSubdomain('example.com');
      expect(trie.match('a.example.com')).toEqual(true);
      expect(trie.match('b.example.com')).toEqual(true);
      expect(trie.match('anything.example.com')).toEqual(true);
    });

    it('should drop exact on same node when subdomain is added', () => {
      // subdomain marker subsumes exact on the same node (exact is redundant)
      const trie = new HostnameSmolTrie();
      trie.add('example.com');

      trie.addSubdomain('example.com');
      expect(trie.has('example.com')).toEqual(false);
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.match('example.com')).toEqual(true);
    });

    it('should skip add when already covered by ancestor subdomain', () => {
      // ancestor subdomain already covers this hostname — no-op
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      trie.add('www.example.com');
      expect(trie.has('www.example.com')).toEqual(false);
      expect(trie.match('www.example.com')).toEqual(true);
    });

    it('should skip addSubdomain when already covered by ancestor subdomain', () => {
      // narrower subdomain is redundant when ancestor already covers it
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      trie.addSubdomain('sub.example.com');
      expect(trie.hasSubdomain('sub.example.com')).toEqual(false);
    });

    it('should prune deeply nested children', () => {
      // pruning is recursive — all descendants are removed regardless of depth
      const trie = new HostnameSmolTrie();
      trie.add('deep.sub.www.example.com');
      trie.add('other.sub.www.example.com');
      trie.addSubdomain('sub.www.example.com');
      expect(trie.match('deep.sub.www.example.com')).toEqual(true);
      expect(trie.match('other.sub.www.example.com')).toEqual(true);
      expect(trie.match('new.sub.www.example.com')).toEqual(true);
    });

    it('should prune subdomain children too', () => {
      // narrower subdomain markers are also pruned by a broader ancestor
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('a.example.com');
      trie.addSubdomain('b.example.com');

      trie.addSubdomain('example.com');
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.hasSubdomain('a.example.com')).toEqual(false);
      expect(trie.hasSubdomain('b.example.com')).toEqual(false);
    });

    it('should not affect sibling branches when pruning', () => {
      // pruning only affects descendants — sibling branches stay intact
      const trie = new HostnameSmolTrie();
      trie.add('a.example.com');
      trie.add('a.other.com');
      trie.addSubdomain('example.com');
      expect(trie.match('a.example.com')).toEqual(true);
      expect(trie.match('a.other.com')).toEqual(true);
      expect(trie.has('a.other.com')).toEqual(true);
    });
  });

  describe('match', () => {
    it('should match exact domains', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      expect(trie.match('example.com')).toEqual(true);
      expect(trie.match('other.com')).toEqual(false);
    });

    it('should short-circuit on subdomain match', () => {
      // match() stops walking as soon as it hits a subdomain marker — no need to check deeper
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('example.com')).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(true);
      expect(trie.match('a.b.c.example.com')).toEqual(true);
      expect(trie.match('other.com')).toEqual(false);
    });

    it('should not match partial domain names', () => {
      // label-boundary aware: "notexample.com" is NOT a subdomain of "example.com"
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      expect(trie.match('notexample.com')).toEqual(false);
      expect(trie.match('myexample.com')).toEqual(false);
    });

    it('should handle no match', () => {
      const trie = new HostnameSmolTrie();
      expect(trie.match('anything.com')).toEqual(false);
    });
  });

  describe('remove', () => {
    it('should remove an exact domain', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      expect(trie.remove('example.com')).toEqual(true);
      expect(trie.has('example.com')).toEqual(false);
    });

    it('should remove a subdomain entry', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      expect(trie.removeSubdomain('example.com')).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(false);
    });

    it('should return false for non-existent', () => {
      const trie = new HostnameSmolTrie();
      expect(trie.remove('example.com')).toEqual(false);
      expect(trie.removeSubdomain('example.com')).toEqual(false);
    });

    it('should clean up empty nodes', () => {
      // removing the only entry prunes all intermediate nodes back to root
      const trie = new HostnameSmolTrie();
      trie.add('deep.sub.example.com');
      trie.remove('deep.sub.example.com');
      expect(trie._root.c).toEqual(null);
    });
  });

  describe('compact', () => {
    it('should compact and still match correctly', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');
      trie.add('other.com');
      trie.compact();

      expect(trie.compacted).toEqual(true);
      expect(trie.match('www.example.com')).toEqual(true);
      expect(trie.match('other.com')).toEqual(true);
      expect(trie.match('www.other.com')).toEqual(false);
    });

    it('should auto-expand on mutation when compacted', () => {
      const trie = new HostnameSmolTrie();
      trie.add('a.com');
      trie.compact();
      expect(trie.compacted).toEqual(true);

      trie.add('b.com');
      expect(trie.compacted).toEqual(false);
      expect(trie.match('a.com')).toEqual(true);
      expect(trie.match('b.com')).toEqual(true);
    });

    it('should handle has/hasSubdomain in compacted mode', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      trie.addSubdomain('other.com');
      trie.compact();

      expect(trie.has('example.com')).toEqual(true);
      expect(trie.hasSubdomain('other.com')).toEqual(true);
      expect(trie.has('other.com')).toEqual(false);
      expect(trie.hasSubdomain('example.com')).toEqual(false);
    });

    it('should compress and match across radix nodes', () => {
      const trie = new HostnameSmolTrie();
      trie.add('deep.sub.example.com');
      trie.compact();
      expect(trie.match('deep.sub.example.com')).toEqual(true);
      expect(trie.match('sub.example.com')).toEqual(false);
    });
  });

  describe('dump / load', () => {
    it('should round-trip exact entries', () => {
      const trie = new HostnameSmolTrie();
      trie.add('a.com');
      trie.add('b.org');

      const dumped = collectDump(trie);
      const restored = HostnameSmolTrie.load(dumped);

      expect(restored.match('a.com')).toEqual(true);
      expect(restored.match('b.org')).toEqual(true);
      expect(restored.match('c.com')).toEqual(false);
    });

    it('should round-trip subdomain entries with dot prefix', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('example.com');

      const dumped = collectDump(trie);
      expect(dumped).toEqual(['.example.com']);

      const restored = HostnameSmolTrie.load(dumped);
      expect(restored.match('www.example.com')).toEqual(true);
      expect(restored.hasSubdomain('example.com')).toEqual(true);
    });

    it('should round-trip mixed entries', () => {
      const trie = new HostnameSmolTrie();
      trie.add('specific.com');
      trie.addSubdomain('wildcard.com');

      const dumped = collectDump(trie);
      const restored = HostnameSmolTrie.load(dumped);

      expect(restored.match('specific.com')).toEqual(true);
      expect(restored.match('www.specific.com')).toEqual(false);
      expect(restored.match('www.wildcard.com')).toEqual(true);
    });

    it('should handle empty trie', () => {
      const trie = new HostnameSmolTrie();
      const dumped = collectDump(trie);
      expect(dumped).toEqual([]);
      const restored = HostnameSmolTrie.load(dumped);
      expect(restored.match('anything.com')).toEqual(false);
    });

    it('should apply deduplication on load', () => {
      // load() runs the same dedup logic as add — subdomain marker prunes the exact child
      const entries = ['www.example.com', '.example.com'];
      const trie = HostnameSmolTrie.load(entries);
      expect(trie.hasSubdomain('example.com')).toEqual(true);
      expect(trie.has('www.example.com')).toEqual(false);
    });

    it('should group domains sharing the longest suffix together via DFS', () => {
      // DFS traversal naturally groups domains by shared suffix:
      // a.com → www.a.com → blog.www.a.com (deepest first), then siblings
      const trie = new HostnameSmolTrie();
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
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('skk.moe');
      trie.add('noc.one');
      trie.add('cdn.noc.one');
      trie.add('api.noc.one');
      trie.add('example.com');

      expect(collectDump(trie)).toEqual([
        '.skk.moe',
        'noc.one',
        'cdn.noc.one',
        'api.noc.one',
        'example.com'
      ]);
    });

    it('should decompress a TLD-only entry instead of dumping its raw compressed ID', () => {
      // regression test: a single-label hostname IS the TLD slot itself, so
      // labelsToHostname must decompress labels[0] even when labels.length === 1
      const trie = new HostnameSmolTrie();
      trie.add('com');

      expect(collectDump(trie)).toEqual(['com']);
    });

    it('should decompress a TLD-only entry after compaction', () => {
      const trie = new HostnameSmolTrie();
      trie.add('com');
      trie.compact();

      expect(collectDump(trie)).toEqual(['com']);
    });
  });

  describe('TLD compression', () => {
    it('should handle multi-part TLDs', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('bbc.co.uk');
      expect(trie.match('www.bbc.co.uk')).toEqual(true);
      expect(trie.match('other.co.uk')).toEqual(false);
    });
  });

  describe('edge cases', () => {
    it('should handle single-label hostname', () => {
      const trie = new HostnameSmolTrie();
      trie.add('localhost');
      expect(trie.match('localhost')).toEqual(true);
    });

    it('should handle trailing dot', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com.');
      expect(trie.match('example.com')).toEqual(true);
    });

    it('should handle TLD-only subdomain', () => {
      const trie = new HostnameSmolTrie();
      trie.addSubdomain('com');
      expect(trie.match('anything.com')).toEqual(true);
      expect(trie.match('anything.org')).toEqual(false);
    });

    it('should handle many domains efficiently', () => {
      const trie = new HostnameSmolTrie();
      for (let i = 0; i < 100; i++) {
        trie.add(`domain${i}.com`);
      }
      // adding subdomain on TLD collapses all 100 entries into 1
      trie.addSubdomain('com');
      expect(trie.match('domain50.com')).toEqual(true);
      expect(trie.match('anything.com')).toEqual(true);
    });

    it('should handle duplicate adds idempotently', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      // eslint-disable-next-line sukka/no-element-overwrite -- intentional duplicate add
      trie.add('example.com');
      expect(trie.has('example.com')).toEqual(true);

      trie.addSubdomain('other.com');
      trie.addSubdomain('other.com');
      expect(trie.hasSubdomain('other.com')).toEqual(true);
    });
  });

  describe('constructor', () => {
    it('should create from array with dot-prefix', () => {
      const trie = new HostnameSmolTrie([
        'skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe',
        'blog.skk.moe',
        '.cdn.local',
        'blog.img.skk.local',
        'img.skk.local'
      ]);

      expect(collectDump(trie)).toEqual([
        'skk.moe',
        'blog.skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe',
        '.cdn.local',
        'img.skk.local',
        'blog.img.skk.local'
      ]);
    });

    it('should create from null', () => {
      const trie = new HostnameSmolTrie(null);
      expect(trie.match('anything.com')).toEqual(false);
    });

    it('should create from Set', () => {
      const trie = new HostnameSmolTrie(new Set(['skk.moe', 'example.com']));
      expect(trie.has('skk.moe')).toEqual(true);
      expect(trie.has('example.com')).toEqual(true);
    });
  });

  describe('dot-prefix convention', () => {
    it('should route dot-prefix add to addSubdomain', () => {
      const trie = new HostnameSmolTrie();
      trie.add('.skk.moe');
      expect(trie.hasSubdomain('skk.moe')).toEqual(true);
      expect(trie.has('skk.moe')).toEqual(false);
    });

    it('should dedupe with dot-prefix add', () => {
      const trie = new HostnameSmolTrie([
        '.skk.moe', 'blog.skk.moe', '.cdn.skk.moe', 'skk.moe',
        'www.noc.one', 'cdn.noc.one',
        '.blog.sub.example.com', 'sub.example.com', 'cdn.sub.example.com', '.sub.example.com'
      ]);

      expect(collectDump(trie)).toEqual([
        '.skk.moe',
        'www.noc.one',
        'cdn.noc.one',
        '.sub.example.com'
      ]);
    });

    it('should dedupe simple tree - 2', () => {
      const trie = new HostnameSmolTrie([
        '.skk.moe', 'blog.skk.moe', '.cdn.skk.moe', 'skk.moe'
      ]);

      expect(collectDump(trie)).toEqual([
        '.skk.moe'
      ]);
    });

    it('should dedupe simple tree - 3', () => {
      const trie = new HostnameSmolTrie([
        '.blog.sub.example.com', 'cdn.sub.example.com', '.sub.example.com'
      ]);

      expect(collectDump(trie)).toEqual([
        '.sub.example.com'
      ]);

      trie.add('.sub.example.com');
      expect(collectDump(trie)).toEqual([
        '.sub.example.com'
      ]);
    });

    it('should handle non-TLD domains', () => {
      const trie = new HostnameSmolTrie([
        'commercial.shouji.360.cn',
        'act.commercial.shouji.360.cn',
        'cdn.creative.medialytics.com',
        'px.cdn.creative.medialytics.com'
      ]);

      expect(collectDump(trie)).toEqual([
        'commercial.shouji.360.cn',
        'act.commercial.shouji.360.cn',
        'cdn.creative.medialytics.com',
        'px.cdn.creative.medialytics.com'
      ]);
    });

    it('should not dedupe non-subdomain entries', () => {
      const trie = new HostnameSmolTrie([
        'skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe',
        'blog.skk.moe'
      ]);

      expect(collectDump(trie)).toEqual([
        'skk.moe',
        'blog.skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe'
      ]);
    });
  });

  describe('whitelist', () => {
    it('should whitelist subdomain entries', () => {
      // whitelist('.x') removes the subdomain marker AND all children under x
      // whitelist('x') removes only exact+subdomain flags on x, keeps children
      const trie = new HostnameSmolTrie([
        'skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe',
        'blog.skk.moe',
        '.cdn.local',
        'blog.img.skk.local',
        'img.skk.local'
      ]);

      // subdomain whitelist: removes skk.moe, blog.skk.moe (the node + all children)
      trie.whitelist('.skk.moe');

      expect(collectDump(trie)).toEqual([
        'anotherskk.moe',
        'blog.anotherskk.moe',
        '.cdn.local',
        'img.skk.local',
        'blog.img.skk.local'
      ]);

      // exact whitelist: removes only the exact+subdomain flags on anotherskk.moe, keeps child blog.anotherskk.moe
      trie.whitelist('anotherskk.moe');
      expect(collectDump(trie)).toEqual([
        'blog.anotherskk.moe',
        '.cdn.local',
        'img.skk.local',
        'blog.img.skk.local'
      ]);

      // re-add then subdomain-whitelist: wipes the re-added exact AND child blog.anotherskk.moe
      trie.add('anotherskk.moe');
      trie.whitelist('.anotherskk.moe');

      expect(collectDump(trie)).toEqual([
        '.cdn.local',
        'img.skk.local',
        'blog.img.skk.local'
      ]);

      // exact whitelist on leaf: removes only img.skk.local, child blog.img.skk.local survives
      trie.whitelist('img.skk.local');
      expect(collectDump(trie)).toEqual([
        '.cdn.local',
        'blog.img.skk.local'
      ]);

      // exact whitelist on subdomain marker: cdn.local has no exact flag, but has subdomain flag — both cleared
      trie.whitelist('cdn.local');
      expect(collectDump(trie)).toEqual([
        'blog.img.skk.local'
      ]);

      // subdomain whitelist on ancestor: wipes entire .local subtree including blog.img.skk.local
      trie.whitelist('.skk.local');
      expect(collectDump(trie)).toEqual([]);
    });

    it('should whitelist trie correctly', () => {
      // dedup on load: t.co and example.t.co subsumed by .t.co
      const trie = new HostnameSmolTrie([
        '.t.co',
        't.co',
        'example.t.co',
        '.skk.moe',
        'blog.cdn.example.com',
        'cdn.example.com'
      ]);

      // after dedup: .t.co absorbed t.co+example.t.co; .skk.moe stands alone; cdn.example.com keeps child
      expect(collectDump(trie)).toEqual([
        '.t.co',
        '.skk.moe',
        'cdn.example.com', 'blog.cdn.example.com'
      ]);

      // subdomain whitelist: removes .t.co and everything under it
      trie.whitelist('.t.co');
      expect(collectDump(trie)).toEqual([
        '.skk.moe', 'cdn.example.com', 'blog.cdn.example.com'
      ]);

      // exact whitelist on skk.moe: .skk.moe has subdomain flag — exact whitelist clears both flags
      trie.whitelist('skk.moe');
      expect(collectDump(trie)).toEqual(['cdn.example.com', 'blog.cdn.example.com']);

      // exact whitelist on cdn.example.com: removes only its flags, child blog.cdn.example.com survives
      trie.whitelist('cdn.example.com');
      expect(collectDump(trie)).toEqual(['blog.cdn.example.com']);
    });
  });

  describe('contains', () => {
    // contains() is an alias of match() — tests verify both exact and subdomain matching
    it('should match exact entries', () => {
      const trie = new HostnameSmolTrie([
        'skk.moe',
        'anotherskk.moe',
        'blog.anotherskk.moe',
        'blog.skk.moe'
      ]);

      // exact entries match themselves
      expect(trie.contains('skk.moe')).toEqual(true);
      expect(trie.contains('blog.skk.moe')).toEqual(true);
      expect(trie.contains('anotherskk.moe')).toEqual(true);
      expect(trie.contains('blog.anotherskk.moe')).toEqual(true);

      // no subdomain fallback for exact-only entries — cdn.skk.moe is NOT matched by exact skk.moe
      expect(trie.contains('example.com')).toEqual(false);
      expect(trie.contains('blog.example.com')).toEqual(false);
      expect(trie.contains('skk.mo')).toEqual(false);
      expect(trie.contains('cdn.skk.moe')).toEqual(false);
    });

    it('should not match parent of exact entry', () => {
      // only exact: index.rubygems.org — parent rubygems.org and child sub.index... must not match
      const trie = new HostnameSmolTrie(['index.rubygems.org']);

      expect(trie.contains('rubygems.org')).toEqual(false);
      expect(trie.contains('index.rubygems.org')).toEqual(true);
      expect(trie.contains('sub.index.rubygems.org')).toEqual(false);
    });

    it('should match subdomains with subdomain marker', () => {
      // .skk.moe matches skk.moe itself AND any subdomain at any depth
      const trie = new HostnameSmolTrie(['.skk.moe']);

      expect(trie.contains('skk.moe')).toEqual(true);
      expect(trie.contains('blog.skk.moe')).toEqual(true);
      expect(trie.contains('image.cdn.skk.moe')).toEqual(true);

      // different domain entirely — no match
      expect(trie.contains('example.com')).toEqual(false);
      expect(trie.contains('blog.example.com')).toEqual(false);
      expect(trie.contains('skk.mo')).toEqual(false);
    });
  });

  describe('find', () => {
    it('should find entries in smol trie', () => {
      const trie = new HostnameSmolTrie();
      trie.add('.example.com');
      // dedup: example.com, blog/cdn.example.com subsumed by .example.com
      trie.add('example.com');
      trie.add('blog.example.com');
      trie.add('cdn.example.com');
      trie.add('example.org');

      // find('example.com') returns .example.com (subdomain marker covers everything under it)
      expect(trie.find('example.com')).toEqual(['.example.com']);
      // find('com') walks to TLD node, finds .example.com underneath
      expect(trie.find('com')).toEqual(['.example.com']);
      // dot-prefix query: find('.example.com') returns subdomain marker itself
      expect(trie.find('.example.com')).toEqual(['.example.com']);
      expect(trie.find('org')).toEqual(['example.org']);
      // no entries under .net
      expect(trie.find('example.net')).toEqual([]);
      // dump confirms dedup: only .example.com + example.org survive
      expect(collectDump(trie)).toEqual(['.example.com', 'example.org']);
    });

    it('should find entries when the prefix lands inside a radix-compressed node', () => {
      // regression test: compaction collapses 'deep.sub.example.com' into a single
      // multi-label node, so a prefix query for 'sub.example.com' lands mid-node —
      // find() must expand before walking, not rely on the compacted-mode walker
      const trie = new HostnameSmolTrie();
      trie.add('deep.sub.example.com');
      trie.add('other.sub.example.com');
      trie.compact();

      expect(trie.find('sub.example.com')).toEqual(['deep.sub.example.com', 'other.sub.example.com']);
    });

    it('should restore compaction after find() on a compacted trie', () => {
      // find() expands internally to walk mid-node prefixes, but must not leak
      // that expansion back to the caller — compacted state should be unchanged
      const trie = new HostnameSmolTrie();
      trie.add('deep.sub.example.com');
      trie.add('other.sub.example.com');
      trie.compact();

      trie.find('sub.example.com');
      expect(trie.compacted).toEqual(true);
      expect(trie.match('deep.sub.example.com')).toEqual(true);

      // also true when the prefix isn't found at all
      trie.find('no-match.org');
      expect(trie.compacted).toEqual(true);
    });

    it('should leave an uncompacted trie uncompacted after find()', () => {
      const trie = new HostnameSmolTrie();
      trie.add('example.com');
      trie.find('example.com');
      expect(trie.compacted).toEqual(false);
    });
  });

  describe('surge domainset dedupe', () => {
    it('should find subdomains under a prefix', () => {
      const trie = new HostnameSmolTrie(['www.noc.one', 'www.sukkaw.com', 'blog.skk.moe', 'image.cdn.skk.moe', 'cdn.sukkaw.net']);
      expect(trie.find('.skk.moe')).toEqual(['blog.skk.moe', 'image.cdn.skk.moe']);
      expect(trie.find('.sukkaw.com')).toEqual(['www.sukkaw.com']);
    });

    it('should dedupe when subdomain marker covers children', () => {
      // .skk.moe subdomain marker prunes blog.skk.moe and image.cdn.skk.moe — only the marker remains
      const trie = new HostnameSmolTrie(['www.noc.one', 'www.sukkaw.com', '.skk.moe', 'blog.skk.moe', 'image.cdn.skk.moe', 'cdn.sukkaw.net']);
      expect(trie.find('.skk.moe')).toEqual(['.skk.moe']);
      expect(trie.find('.sukkaw.com')).toEqual(['www.sukkaw.com']);
    });

    it('should not find non-subdomain', () => {
      // "sukkaskk.moe" is NOT a subdomain of "skk.moe" — different label
      const trie = new HostnameSmolTrie(['skk.moe', 'sukkaskk.moe']);
      expect(trie.find('.skk.moe')).toEqual([]);
    });
  });

  describe('empty string', () => {
    it('should add and find empty hostname', () => {
      const trie = new HostnameSmolTrie();
      trie.add('');
      expect(trie.has('')).toEqual(true);
    });
  });
});
