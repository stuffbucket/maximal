// Post-build guard: assert the built site/dist will render correctly once the
// GitHub Pages deploy action publishes it — so a regression FAILS THE DEPLOY
// instead of silently shipping a broken page. Run after `astro build`, before
// the artifact upload (wired into .github/workflows/deploy-pages.yml).
//
// mxml.sh is a GitHub Pages CUSTOM DOMAIN served at ROOT (see astro.config.mjs
// + docs). Two ways that has silently broken before, both caught here:
//   1. A "/maximal" Astro `base` re-emits /maximal/* asset URLs that 404 at the
//      root-served domain (the page renders unstyled). Issue #289.
//   2. A missing or typo'd CNAME drops the custom domain on deploy. PR #288
//      shipped a root CNAME reading "msmxl.sh". PR #292 removed it.
//
// Exits non-zero with a precise message on any violation.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");
const EXPECTED_CNAME = "mxml.sh";

const errors = [];

/** All files under a dir whose name matches `test`, recursively. */
function walk(dir, test, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, test, out);
    else if (test(name)) out.push(p);
  }
  return out;
}

// 1. CNAME present + exactly the expected apex (catches missing / typo'd domain).
const cnamePath = join(DIST, "CNAME");
if (!existsSync(cnamePath)) {
  errors.push(
    `dist/CNAME is missing — the deploy would drop the ${EXPECTED_CNAME} custom domain. It must live at site/public/CNAME.`,
  );
} else {
  const cname = readFileSync(cnamePath, "utf8").trim();
  if (cname !== EXPECTED_CNAME) {
    errors.push(
      `dist/CNAME is "${cname}", expected "${EXPECTED_CNAME}" (site/public/CNAME).`,
    );
  }
}

// 2. No site-relative /maximal/ asset URLs — the base-path regression. Matches
//    src="/maximal/..." / href="/maximal/..." only; absolute github.com repo
//    links (github.com/stuffbucket/maximal/...) are fine and NOT matched.
const html = walk(DIST, (n) => n.endsWith(".html"));
const badBaseRe = /(?:src|href)="\/maximal\//g;
for (const file of html) {
  const body = readFileSync(file, "utf8");
  const hits = body.match(badBaseRe);
  if (hits) {
    const rel = file.slice(DIST.length + 1);
    errors.push(
      `${rel}: ${hits.length} site-relative /maximal/ asset URL(s) — Astro \`base\` must be "/" for the root-served custom domain, not "/maximal". e.g. ${hits[0]}`,
    );
  }
}

// 3. The core styling/entry assets actually exist (a build that emitted zero
//    CSS would "render" but be blank — belt-and-braces).
const astroDir = join(DIST, "_astro");
const css = existsSync(astroDir)
  ? walk(astroDir, (n) => n.endsWith(".css"))
  : [];
if (css.length === 0) {
  errors.push("dist/_astro contains no .css — the styled build didn't emit.");
}
if (!existsSync(join(DIST, "favicon.svg"))) {
  errors.push("dist/favicon.svg is missing.");
}

if (errors.length > 0) {
  console.error("verify-dist: FAILED\n");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    `\n${errors.length} problem(s). The built site would not render correctly at https://${EXPECTED_CNAME}/.`,
  );
  process.exit(1);
}

console.log(
  `verify-dist: OK — dist/CNAME=${EXPECTED_CNAME}, ${html.length} HTML file(s) clean of /maximal/ asset paths, ${css.length} CSS asset(s) present.`,
);
