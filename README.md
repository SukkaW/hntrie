# hntrie

> The extremely fast Trie implementation optimized for hostnames

`hntrie` indexes hostnames label-by-label, right to left (TLD first, the way a domain actually parses), with built-in exact-match vs. subdomain-match semantics, radix compression, and serialization. It ships two implementations:

- **`HostnameTrie`** — a full trie that stores an arbitrary value per entry. Use it when you need to look up data associated with a hostname (rules, categories, config, feature flags, etc.).
- **`HostnameSmolTrie`** (`hntrie/smol`) — a minimal boolean-only trie optimized purely for deduplication checks, with no per-entry value storage. Use it when all you need is "does this set contain/cover this hostname" — e.g. deduplicating domain lists when building blocklists/allowlists/split-tunnel vpn configs.

## Install

```bash
npm install hntrie
yarn add hntrie
pnpm add hntrie
```

## Usage

### `HostnameTrie`

```ts
import { HostnameTrie } from 'hntrie';

const trie = new HostnameTrie<string>();

trie.add('example.com', 'exact-rule');
trie.addSubdomain('cdn.example.com', 'subdomain-rule'); // matches cdn.example.com AND *.cdn.example.com

trie.match('example.com');
//=> 'exact-rule'
trie.match('foo.cdn.example.com');
//=> 'subdomain-rule'
trie.match('other.com');
//=> null

trie.has('example.com'); // exact entry exists
//=> true
trie.hasSubdomain('cdn.example.com'); // subdomain entry exists
//=> true
```

A dot-prefix (`.example.com`) is shorthand for `addSubdomain`/`removeSubdomain`, so a trie can also be built straight from an iterable:

```ts
const trie = new HostnameTrie([
  'example.com', // exact only
  '.cdn.example.com' // subdomain, covers cdn.example.com and all of its subdomains
]);
```

Call `.compact()` to radix-compress single-child chains (e.g. collapsing `a -> b -> c` into one node) and reduce memory footprint for large, mostly-static tries. The trie keeps working normally afterwards — any mutation transparently expands it back first.

```ts
trie.compact();
trie.match('example.com'); // still works
trie.add('new.com'); // automatically expands, then adds
```

`serialize`/`deserialize` round-trip a trie to/from a string, with optional `valueToString`/`valueFromString` for non-JSON-serializable values:

```ts
const serialized = trie.serialize();
const restored = HostnameTrie.deserialize<string>(serialized);
```

Iterate entries directly, or stream them through a callback with `dump` (no intermediate array allocation, so entries can be pushed straight into whatever container is already on hand):

```ts
for (const [hostname, value, kind] of trie) {
  // kind is 'exact' | 'subdomain'
}

trie.dump((hostname, includeSubdomain, value) => {
  // called once per entry; includeSubdomain mirrors the dot-prefix convention
});
```

### `HostnameSmolTrie`

Same hostname/subdomain matching semantics as `HostnameTrie`, but without per-entry values — it only tracks whether a hostname (or subdomain) is present. Well suited for large domain lists where only membership matters; it automatically dedupes and prunes redundant entries as they're added.

```ts
import { HostnameSmolTrie } from 'hntrie/smol';

const trie = new HostnameSmolTrie();

trie.addSubdomain('example.com'); // covers example.com and all subdomains
trie.add('foo.example.com'); // redundant, already covered — silently ignored

trie.match('foo.example.com');
//=> true
trie.match('example.com');
//=> true
trie.match('other.com');
//=> false
```

Building from a list dedupes overlapping entries automatically:

```ts
const trie = new HostnameSmolTrie([
  '.example.com', // covers the whole example.com subtree
  'foo.example.com', // redundant, dropped
  'bar.com'
]);

trie.dump((hostname, includeSubdomain) => {
  // only '.example.com' and 'bar.com' come out — foo.example.com was deduped away
});
```

`whitelist(hostname)` removes a hostname (and everything under it, for subdomain entries) — handy for carving out exceptions from a blocklist:

```ts
const blocklist = new HostnameSmolTrie(['foo.example.com', 'bar.com']);
blocklist.whitelist('foo.example.com');

blocklist.match('foo.example.com');
//=> false
blocklist.match('bar.com');
//=> true
```

Whitelisting only removes an entry that exists as its own node — if `foo.example.com` is already covered by a broader `.example.com` subdomain entry, whitelist that broader entry instead.

`HostnameSmolTrie` also supports `.compact()`, `.find(prefix)`, and `.dump()`/`HostnameSmolTrie.load()` for round-tripping, with the same semantics as `HostnameTrie` minus the stored values.

## License

[MIT](LICENSE)

----

**hntrie** © [Sukka](https://github.com/SukkaW), Released under the [MIT](./LICENSE) License.
Authored and maintained by Sukka with help from contributors ([list](https://github.com/SukkaW/hntrie/graphs/contributors)).

> [Personal Website](https://skk.moe) · [Blog](https://blog.skk.moe) · GitHub [@SukkaW](https://github.com/SukkaW) · Telegram Channel [@SukkaChannel](https://t.me/SukkaChannel) · Mastodon [@sukka@acg.mn](https://acg.mn/@sukka) · Twitter [@isukkaw](https://twitter.com/isukkaw) · BlueSky [@skk.moe](https://bsky.app/profile/skk.moe)

<p align="center">
  <a href="https://github.com/sponsors/SukkaW/">
    <img src="https://sponsor.cdn.skk.moe/sponsors.svg"/>
  </a>
</p>
