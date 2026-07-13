# Anthropic /v1/models schema (fetched 2026-07-03, platform.claude.com)

## List envelope (NOT OpenAI's object:"list")
```
{ data: ModelInfo[], first_id: string, has_more: boolean, last_id: string }
```
Query params: after_id, before_id, limit (default 20, 1..1000).

## ModelInfo entry
- id: string
- type: "model"            (always)
- display_name: string
- created_at: string       (RFC 3339; epoch if unknown)
- max_input_tokens: number
- max_tokens: number        (max value for max_tokens param)
- capabilities: {
    batch:{supported}, citations:{supported}, code_execution:{supported},
    context_management:{supported, clear_thinking_20251015:{supported}, ...},
    effort:{supported, low/medium/high/xhigh/max:{supported}},
    image_input:{supported}, pdf_input:{supported},
    structured_outputs:{supported},
    thinking:{supported, types:{adaptive:{supported}, enabled:{supported}}}
  }
NO: object, created, owned_by, billing.

## OpenAI /v1/models (for contrast, historical maximal contract)
{ object:"list", data:[{ id, object:"model", created:number, owned_by:string }], has_more }

## maximal Copilot Model (upstream source) — key fields
id, name, vendor, version, object, model_picker_enabled, preview,
capabilities:{ family, type, tokenizer, object, limits:{max_context_window_tokens,max_output_tokens,...}, supports:{tool_calls,streaming,vision,adaptive_thinking,reasoning_effort[],...} },
billing:{is_premium,multiplier,restricted_to[]}, policy, supported_endpoints[]

## Mapping Copilot -> Anthropic ModelInfo
- id -> forwardId(id)
- display_name <- name
- created_at <- epoch (0) unless we have real date  (Anthropic allows epoch)
- max_input_tokens <- capabilities.limits.max_context_window_tokens ?? 0
- max_tokens <- capabilities.limits.max_output_tokens ?? 0
- capabilities.image_input.supported <- supports.vision
- capabilities.thinking.supported <- supports.adaptive_thinking || reasoning_effort?.length
- capabilities.structured_outputs.supported <- supports.structured_outputs
- (batch/citations/code_execution/pdf_input -> false unless known)

## Client keying (already exists)
- requestContext.userAgent captured per request
- humanizeUserAgent classifies: claude-code, anthropic/*, openai/*, opencode, cline...
- Anthropic clients also send `anthropic-version` header -> strongest signal
- Plan: /v1/models negotiates: anthropic-version header OR anthropic/claude UA -> Anthropic shape; else OpenAI shape (documented default, back-comat for Codex/LiteLLM)

## Tauri UI: uses /settings/api/models (own DTO), NOT /v1/models. Untouched by negotiation.
EOF
