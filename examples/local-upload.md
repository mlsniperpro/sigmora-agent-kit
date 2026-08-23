# Upload local footage

```sh
export SIGMORA_API_KEY='your-workspace-key'
sigmora upload ./footage/interview.mp4 --project prj_example --json
```

The command prints progress to stderr and one machine-readable result to stdout. Repeating the same file/project upload reuses a deterministic idempotency key. The result contains stable `assetId` and `contentId` references for later MCP calls.

Never put a provider key on the command line or in a host template. `SIGMORA_API_KEY` is the only credential read by this CLI.
