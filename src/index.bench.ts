import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HostnameTrie } from './index.ts';
import { HostnameSmolTrie } from './smol.ts';

const PSL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const DATA_DIR = path.join(import.meta.dirname, '..', '.bench-data');
const DATA_FILE = path.join(DATA_DIR, 'public_suffix_list.dat');

async function loadPublicSuffixList(): Promise<string[]> {
  if (!existsSync(DATA_FILE)) {
    mkdirSync(DATA_DIR, { recursive: true });
    // eslint-disable-next-line no-console -- bench script progress output
    console.log(`Downloading ${PSL_URL} ...`);
    const res = await fetch(PSL_URL);
    writeFileSync(DATA_FILE, await res.text());
  }

  const raw = readFileSync(DATA_FILE, 'utf-8');
  const hostnames: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    // wildcard ("*.foo") and exception ("!foo") markers — strip to plain hostnames
    let hostname = trimmed;
    if (trimmed.startsWith('*.')) {
      hostname = trimmed.slice(2);
    } else if (trimmed[0] === '!') {
      hostname = trimmed.slice(1);
    }
    hostnames.push(hostname);
  }

  return hostnames;
}

(async () => {
  const { run, bench, group, summary, do_not_optimize } = await import('mitata');

  const hostnames = await loadPublicSuffixList();
  // eslint-disable-next-line no-console -- bench script progress output
  console.log(`Loaded ${hostnames.length} hostnames from the Public Suffix List\n`);

  // pre-built tries reused across the lookup/dump benchmarks
  const prebuiltTrie = new HostnameTrie(hostnames);
  const prebuiltSmolTrie = new HostnameSmolTrie(hostnames);
  const prebuiltCompactedTrie = new HostnameTrie(hostnames).compact();
  const prebuiltCompactedSmolTrie = new HostnameSmolTrie(hostnames).compact();

  // a fixed sample of lookup targets — mix of hits and misses, independent of insertion order
  const sampleSize = Math.min(2000, hostnames.length);
  const step = Math.max(1, Math.floor(hostnames.length / sampleSize));
  const lookupSampleHits: string[] = [];
  for (let i = 0; i < hostnames.length; i += step) lookupSampleHits.push(hostnames[i]);
  const lookupSampleMisses = lookupSampleHits.map(h => `not-present-${h}`);

  summary(() => {
    group('bulk construction (entire Public Suffix List)', () => {
      bench('HostnameTrie: new HostnameTrie(hostnames)', () => {
        do_not_optimize(new HostnameTrie(hostnames));
      });

      bench('HostnameSmolTrie: new HostnameSmolTrie(hostnames)', () => {
        do_not_optimize(new HostnameSmolTrie(hostnames));
      });
    });
  });

  summary(() => {
    group('lookup: match() — hits', () => {
      bench('HostnameTrie (uncompacted)', () => {
        for (const h of lookupSampleHits) do_not_optimize(prebuiltTrie.match(h));
      });

      bench('HostnameTrie (compacted)', () => {
        for (const h of lookupSampleHits) do_not_optimize(prebuiltCompactedTrie.match(h));
      });

      bench('HostnameSmolTrie (uncompacted)', () => {
        for (const h of lookupSampleHits) do_not_optimize(prebuiltSmolTrie.match(h));
      });

      bench('HostnameSmolTrie (compacted)', () => {
        for (const h of lookupSampleHits) do_not_optimize(prebuiltCompactedSmolTrie.match(h));
      });
    });
  });

  summary(() => {
    group('lookup: match() — misses', () => {
      bench('HostnameTrie (uncompacted)', () => {
        for (const h of lookupSampleMisses) do_not_optimize(prebuiltTrie.match(h));
      });

      bench('HostnameTrie (compacted)', () => {
        for (const h of lookupSampleMisses) do_not_optimize(prebuiltCompactedTrie.match(h));
      });

      bench('HostnameSmolTrie (uncompacted)', () => {
        for (const h of lookupSampleMisses) do_not_optimize(prebuiltSmolTrie.match(h));
      });

      bench('HostnameSmolTrie (compacted)', () => {
        for (const h of lookupSampleMisses) do_not_optimize(prebuiltCompactedSmolTrie.match(h));
      });
    });
  });

  summary(() => {
    group('compact() — entire Public Suffix List', () => {
      bench('HostnameTrie: compact()', function *() {
        yield {
          [0]: () => new HostnameTrie(hostnames),
          bench: (trie: HostnameTrie) => trie.compact()
        };
      });

      bench('HostnameSmolTrie: compact()', function *() {
        yield {
          [0]: () => new HostnameSmolTrie(hostnames),
          bench: (trie: HostnameSmolTrie) => trie.compact()
        };
      });
    });
  });

  summary(() => {
    group('dump() — entire Public Suffix List', () => {
      bench('HostnameTrie: dump()', () => {
        const out: string[] = [];
        prebuiltTrie.dump((hostname) => { out.push(hostname); });
        do_not_optimize(out);
      });

      bench('HostnameSmolTrie: dump()', () => {
        const out: string[] = [];
        prebuiltSmolTrie.dump((hostname) => { out.push(hostname); });
        do_not_optimize(out);
      });
    });
  });

  await run();
})();
