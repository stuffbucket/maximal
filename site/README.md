# maximal — mxml.sh endpoints

mxml.sh is this repository's GitHub Pages site, deployed by
`.github/workflows/deploy-pages.yml`. Its pages (landing and guide) are built
from [stuffbucket/maximal-site](https://github.com/stuffbucket/maximal-site);
see `docs/release-runbook.md` → **mxml.sh pages**. What this directory still
supplies to every deploy:

- `public/CNAME` — the custom domain;
- `public/updates/**` — the manifests installed apps' update checks read,
  written by `release.yml` through `scripts/write-updates-manifest.ts`, which
  also imports the schema from `src/lib/updates-manifest.ts`;
- `public/apt/maximal.asc` — the apt signing key; the signed repository
  itself is built at deploy time;
- `public/maximal/index.html` — the redirect for old app builds;
- `scripts/verify-dist.mjs` — the check the assembled site must pass.

The Astro pages under `src/` are the old site, deployed only as a rollback:
`gh workflow run deploy-pages.yml --ref main -f source=legacy`. Change the
pages in stuffbucket/maximal-site instead.

```sh
bun install
bun run dev      # http://localhost:4321/
bun run build    # → dist/ (the legacy pages)
```
