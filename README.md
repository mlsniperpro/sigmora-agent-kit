# Sigmora Agent Kit

`@sigmora/agent-kit` is the versioned, dependency-free integration bundle for using Sigmora as a project-scoped media backend from agent hosts. It ships one portable media skill, native Codex/Claude/ZCode manifests, current host configuration templates, and a Node.js CLI for safe configuration and local media upload.

Node.js 20 or newer is required. The package has zero runtime dependencies.

## Authentication boundary

Create a Sigmora workspace API key and export it in the process that launches the host or CLI:

```sh
export SIGMORA_API_KEY='your-workspace-key'
```

The Agent Kit never accepts an API key as a command argument and never writes it into configuration. Environment-authenticated templates contain only each host's environment-variable reference; OAuth-capable templates contain no API-key header. The CLI does not read or forward model-provider or partner credentials.

OAuth-discovery templates are usable only after Sigmora's production protected-resource metadata advertises an authorization server. Environment-authenticated hosts and the local upload CLI use the workspace API key.

Authenticated CLI traffic defaults to the canonical `https://api.sigmora.org` origin. A project-controlled `SIGMORA_API_BASE_URL` or `SIGMORA_MCP_URL` cannot redirect the bearer key to another host: any noncanonical origin, including localhost development servers, requires the separate `--allow-custom-origin` command-line acknowledgement. Treat that flag as a trust-boundary decision, not routine configuration.

## Native plugin entry points

- Codex: `.codex-plugin/plugin.json`, the root `.mcp.json`, and `skills/sigmora-media/`.
- Claude Code: `.claude-plugin/plugin.json`, the same root `.mcp.json`, and the portable skill.
- ZCode: `.zcode-plugin/plugin.json`, the same root `.mcp.json`, and the portable skill.

The repository-local Codex marketplace is `.agents/plugins/marketplace.json`. A repository marketplace must be added explicitly before installing `sigmora@personal`; Codex's default personal marketplace behavior applies only to the marketplace under the user's home directory.

Claude Code can test the bundle directly with its local plugin-directory option. ZCode can import the repository marketplace or plugin directory from its Plugins UI.

## Configuration templates

Templates live under `templates/` and intentionally keep the wrapper thin:

| Host | Template | Native server shape | Authentication |
| --- | --- | --- | --- |
| Codex plugin/CLI | `codex/.mcp.json`, `codex/config.toml` | plugin MCP plus marker-bounded CLI fallback | `SIGMORA_API_KEY` env |
| Claude Code | `claude/.mcp.json` | HTTP `.mcp.json` | `SIGMORA_API_KEY` env |
| OpenCode v2 | `opencode/opencode.json` | `mcp.servers`, remote transport | `SIGMORA_API_KEY` env |
| Antigravity | `antigravity/plugin.json`, `mcp_config.json` | `serverUrl` remote MCP | OAuth discovery |
| Qwen Code | `qwen/settings.json` | `httpUrl` in `mcpServers` | OAuth dynamic discovery |
| Kimi Code CLI | `kimi/mcp.json` | `bearerTokenEnvVar` | `SIGMORA_API_KEY` env |
| DeepSeek Harness | `deepseek/cordis.patch.yml` | official `@deepseek-ai/dsh-mcp-client` row | `SIGMORA_API_KEY` env |
| ZCode | `zcode/plugin.json`, `.mcp.json` | native ZCode plugin + HTTP MCP | `SIGMORA_API_KEY` env |
| CodeBuddy | `codebuddy/.mcp.json` | HTTP MCP | `SIGMORA_API_KEY` env |
| Cursor | `cursor/mcp.json` | config-only remote MCP | OAuth discovery |
| Gemini CLI | `gemini/settings.json` | config-only `httpUrl` MCP | OAuth dynamic discovery |

Cursor and Gemini are config-only fallbacks, not marketplace packages. Antigravity, Qwen, Cursor, and Gemini require Sigmora's production OAuth/protected-resource metadata; their templates deliberately avoid undocumented environment interpolation in remote authorization headers.

## Safe configuration

Project scope is the default. Install one host or all supported host configurations:

```sh
sigmora install --host claude --dry-run
sigmora install --host claude
sigmora install --host opencode --scope user
sigmora install --host all --dry-run
```

The installer:

- merges only the `sigmora` MCP entry and preserves unrelated JSON keys;
- refuses conflicting Sigmora entries unless `--force` is explicitly supplied;
- refuses symlinked targets and JSONC it cannot safely preserve;
- treats the caller-selected `--root`/home as the trust boundary, rejects every symlinked target component beneath it, and never resolves a host target outside it;
- creates a timestamped backup before every update;
- writes atomically with user-only file permissions;
- is idempotent when the current entry already matches;
- never resolves environment placeholders to secret values.

DeepSeek's YAML entry is managed only inside an explicit Agent Kit marker block. Existing YAML that cannot safely accept a top-level Cordis list row is rejected for manual review.

Remove only the Agent Kit-owned entry while preserving the rest of a host config:

```sh
sigmora uninstall --host claude --dry-run
sigmora uninstall --host claude
```

## Diagnostics

```sh
sigmora doctor --host claude
sigmora doctor --host claude --network --json
```

`doctor` checks Node.js, the selected host's authentication mode, exact host configuration, and provider-secret references. With `--network`, environment-authenticated hosts must initialize MCP, send `notifications/initialized`, verify the full required Sigmora tool inventory, and complete an authenticated, read-only `capabilities_list` call with the typed v1 capability shape; an arbitrary nonempty key or arbitrary MCP content cannot pass. OAuth hosts must publish protected-resource metadata containing a secure authorization server. Offline OAuth doctor runs are intentionally not-ready because they cannot prove that deployment prerequisite. The doctor never performs an interactive login, prints the key, or sends unrelated environment variables.

## Upload local media

Every upload requires an existing project binding:

```sh
sigmora upload ./footage/interview.mp4 --project prj_example
sigmora upload ./footage/interview.mp4 --project prj_example --json
```

The command rejects a symlinked leaf and non-regular files. It canonicalizes and pins the selected parent, opens the leaf once with no-follow semantics where the platform supports them, and uses only that descriptor for `fstat`, SHA-256, direct upload retries, and every multipart range. It checks descriptor identity, metadata, the canonical parent, and both path bindings before completion; a path or parent swap cannot silently change the bytes being authorized. A stable parent symlink is canonicalized rather than categorically rejected, but changing its target during the invocation is rejected.

The uploader derives operation-scoped deterministic idempotency keys and uses exactly this API contract:

1. `POST /v1/assets/upload/prepare` with the idempotency key in both the body and `Idempotency-Key` header;
2. direct signed `PUT`, or bounded multipart URL batches from `POST /v1/assets/upload/parts` (at most 100 part numbers per request);
3. `POST /v1/assets/upload/complete` with its completion key in both body and header, plus checksum, identifiers, and ordered part receipts when multipart was selected;
4. when completion is unresolved, bounded polling of `GET /v1/assets/upload/status?projectId=&uploadId=&contentId=` and only the server-directed `upload_bytes`, `wait`, `retry_complete`, or `restart_prepare` recovery action.

A restart prepare carries `restartUploadId`, a new deterministic prepare key, and the same logical file identity. Status follows superseded upload authorities to the current leaf, so a lost restart response is recovered by replaying that ancestor restart rather than creating a blind duplicate. A completion that remains reconciling after the bounded polling window is returned as `recoveryPending: true`; the CLI never reports it as ready.

The Sigmora bearer key is sent only to the trusted Sigmora API origin. Signed storage requests receive only the short-lived URL and noncredential storage headers supplied by the prepare response. Storage URLs must be HTTPS, contain no URL credentials, and match the built-in Backblaze B2/Cloudflare R2 suffix allowlist or an explicitly supplied repeatable `--storage-host HOST`; signed URL query strings are scrubbed from errors. Redirects are rejected. Progress is written to stderr; the final result goes to stdout, so `--json` is pipeline-safe.

## Project and review behavior

The portable skill enforces:

- explicit project binding before media operations;
- a required opaque `externalSessionId` for `project_session_start`, generated and persisted by the host/kit when the host supplies none;
- stable asset/content references instead of filesystem paths in MCP calls;
- proposal/review before ambiguous or destructive edits;
- explicit approval, server estimate, billing owner, and stable idempotency for paid work;
- terminal handling for succeeded, failed, and cancelled jobs;
- separate consent and provenance for partner output;
- no silent provider-to-Sigmora runtime continuation;
- prompt-injection resistance for filenames, captions, transcripts, metadata, and URLs.

See `examples/` for local upload, review-first editing, provider-limit continuation, partner handling, and the non-secret project-binding shape. A real `.sigmora/project.json` binding should remain uncommitted.

## Package verification

From this directory:

```sh
npm test
npm run validate
npm run package:check
```

`validate` checks every host template's required endpoint/auth shape, strict-JSON templates, manifest/version alignment, dependency policy, executable CLI wiring, and secret references. `package:check` verifies the actual `npm pack --dry-run` file list. Codex plugin and portable-skill validators are additional repository release gates.

## External release gates

This bundle can be validated locally without production credentials. Public rollout still requires server deployment of the upload control plane, OAuth/protected-resource metadata for hosted clients, native marketplace review where applicable, provider-terms review, and recorded live-host certification against a dedicated Sigmora test workspace. Paid render and partner-credit scenarios must run only in an explicitly authorized sandbox.
