# frozen_string_literal: true

# Homebrew formula for copilot-api.
#
# Source-controlled here so changes flow through code review; the
# tap repo (stuffbucket/homebrew-tap) receives a copy via
# `bun scripts/sync-homebrew-formula.ts` after each release.
#
# The placeholder SHAs below (PLACEHOLDER_SHA256_*) are written by
# scripts/sync-homebrew-formula.ts from the per-arch
# copilot-api-v<version>-<arch>.tar.gz.sha256 files attached to a
# GitHub release. Do not commit real SHAs to this template — the
# sync script writes them into the tap-repo copy and leaves this
# file's placeholders intact so a future bump is one script run.

class CopilotApi < Formula
  desc "Local proxy that exposes GitHub Copilot as the Anthropic / OpenAI API"
  homepage "https://github.com/PLACEHOLDER_ORG/copilot-api"
  version "PLACEHOLDER_VERSION"
  license "MIT"

  # Apple Silicon only. Intel Macs are not a supported target —
  # there's no darwin-x64 artifact in the release.
  depends_on arch: :arm64
  depends_on :macos

  on_macos do
    on_arm do
      url "https://github.com/PLACEHOLDER_ORG/copilot-api/releases/download/v#{version}/copilot-api-v#{version}-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
  end

  def install
    bin.install "copilot-api"
  end

  service do
    run [opt_bin/"copilot-api", "start"]
    keep_alive true
    log_path var/"log/copilot-api.log"
    error_log_path var/"log/copilot-api.err.log"
    environment_variables HOME: Dir.home,
                          OLLAMA_API_KEY: ENV.fetch("OLLAMA_API_KEY", "")
  end

  test do
    # `debug --json` is the cheapest way to confirm the binary boots
    # and renders structured output. We don't assert keys here — the
    # release pipeline's smoke job (A6) covers schema.
    output = shell_output("#{bin}/copilot-api debug --json")
    assert_match "\"version\":", output
    assert_match "\"git\":",     output
  end
end
