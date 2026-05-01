#!/usr/bin/env bash
# install-cowork-egress.sh
#
# Populate Claude Desktop's coworkEgressAllowedHosts (the egress
# allowlist gating Cowork's bundled WebSearch / fetch connectors) with
# a curated set of trustworthy domains useful for development and
# research. Restart Claude Desktop after running.
#
# Inspect:   defaults read com.anthropic.claudefordesktop coworkEgressAllowedHosts
# Remove:    defaults delete com.anthropic.claudefordesktop coworkEgressAllowedHosts
#
# Notes:
#  - Wildcards (`*.example.com`) match subdomains; the bare domain still
#    needs its own entry to allow `example.com` itself.
#  - This is the user-domain plist; on managed devices the same key
#    set via MDM (`/Library/Managed Preferences/...`) takes precedence.
#  - With our proxy doing fetch via OllamaWebExecutor, populating this
#    list is optional — Cowork's bundled connectors aren't on the
#    proxy's path. The list is for users who want Cowork's native
#    web-tool UI to keep working alongside the proxy.

set -euo pipefail

DOMAINS=(
  # Code hosting / version control
  github.com
  "*.github.com"
  githubusercontent.com
  raw.githubusercontent.com
  gist.github.com
  gitlab.com
  "*.gitlab.com"
  bitbucket.org
  "*.bitbucket.org"
  codeberg.org

  # Language official sites + docs
  python.org
  docs.python.org
  nodejs.org
  typescriptlang.org
  rust-lang.org
  doc.rust-lang.org
  go.dev
  golang.org
  ruby-lang.org
  ruby-doc.org
  kotlinlang.org
  swift.org

  # Package registries
  npmjs.com
  pypi.org
  crates.io
  rubygems.org
  mvnrepository.com
  search.maven.org
  packagist.org
  nuget.org
  cocoapods.org
  jsr.io

  # Web platform / browsers
  developer.mozilla.org
  developer.apple.com
  developer.android.com
  developer.chrome.com
  caniuse.com
  web.dev
  whatwg.org

  # Standards bodies
  w3.org
  "*.w3.org"
  ietf.org
  datatracker.ietf.org
  rfc-editor.org
  ecma-international.org

  # Cloud / vendor docs
  learn.microsoft.com
  docs.microsoft.com
  azure.microsoft.com
  techcommunity.microsoft.com
  aws.amazon.com
  docs.aws.amazon.com
  cloud.google.com
  developers.google.com
  developer.hashicorp.com

  # Containers / DevOps
  docker.com
  "*.docker.com"
  kubernetes.io
  helm.sh
  terraform.io
  istio.io
  grafana.com
  prometheus.io

  # OS / Linux distros
  linux.org
  ubuntu.com
  "*.ubuntu.com"
  debian.org
  "*.debian.org"
  fedoraproject.org
  archlinux.org
  alpinelinux.org

  # Q&A / community
  stackoverflow.com
  stackexchange.com
  "*.stackexchange.com"
  serverfault.com
  superuser.com
  askubuntu.com

  # Wikipedia / reference
  wikipedia.org
  "*.wikipedia.org"
  wikimedia.org
  "*.wikimedia.org"

  # News / journalism
  bbc.com
  "*.bbc.com"
  bbc.co.uk
  "*.bbc.co.uk"
  reuters.com
  apnews.com
  theguardian.com
  nytimes.com
  npr.org
  pbs.org

  # Research / academic
  arxiv.org
  nature.com
  science.org
  pubmed.ncbi.nlm.nih.gov
  nih.gov
  "*.nih.gov"
  nist.gov
  ssrn.com

  # AI labs / docs
  anthropic.com
  "*.anthropic.com"
  openai.com
  "*.openai.com"
  platform.openai.com
  huggingface.co
  ollama.com
  "*.ollama.com"
  modelcontextprotocol.io

  # Foundations / dev infra
  mozilla.org
  "*.mozilla.org"
  apache.org
  "*.apache.org"
  vercel.com
  "*.vercel.com"
  netlify.com
  "*.netlify.com"
  cloudflare.com
  "*.cloudflare.com"
  jetbrains.com

  # Testing
  example.com
  example.org
  example.net
)

defaults write com.anthropic.claudefordesktop coworkEgressAllowedHosts \
  -array "${DOMAINS[@]}"

echo "Wrote ${#DOMAINS[@]} entries to coworkEgressAllowedHosts."
echo "Verify:   defaults read com.anthropic.claudefordesktop coworkEgressAllowedHosts"
echo "Restart Claude Desktop to apply (Cmd+Q + relaunch)."
