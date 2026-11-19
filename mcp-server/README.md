# @pinpoint/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
Pinpoint feedback triage to MCP-capable agents (Claude Desktop, IDE copilots,
etc.). It is a thin client over the existing Pinpoint REST API — it stores
nothing and holds no database connection.

## Tools (few, deep)

| Tool | REST call | Description |
|---|---|---|
| `list_projects` | `GET /projects` | List visible projects (optional `search`, `status`). |
| `list_feedback` | `GET /feedback?projectId=…` | List a project's feedback with `status` (server-side) and `severity` (client-side) filters + pagination. |
| `get_feedback` | `GET /feedback` + `GET /annotations/:id/comments` | One feedback item with its comment thread and captured diagnostics (console/network/environment). |
| `update_feedback_status` | `PUT /annotations/:id/status` | Move an item to `active` / `in_progress` / `resolved`. |
| `add_comment` | `POST /annotations/:id/comments` | Add a comment to a feedback item. |

## Authentication

The server authenticates to the Pinpoint API with a **standard org API key**
(`pk_…`), sent as `Authorization: Bearer <key>`. The API accepts such keys
only on the projects, annotations, comments and feedback routes
(`server/src/middleware/apiKeyOrJwt.ts`), which is exactly the surface the
tools below use. Safe methods need the `feedback:read` scope and mutations
(`update_feedback_status`, `add_comment`) need `feedback:write`; a standard
key gets both by default. A missing scope returns 403 `INSUFFICIENT_SCOPE`.

- **Widget keys are rejected up front.** A `pk_widget_…` key is a public,
  project-scoped *submission* credential, not a management credential; the
  client throws a `PinpointConfigError` with a clear message if you configure
  one (the API would reject it as a Bearer anyway).

Configure via environment variables:

```bash
export PINPOINT_API_URL="https://pinpoint.example.com"
export PINPOINT_API_KEY="pk_xxxxxxxx"   # a STANDARD key, not pk_widget_
```

### Security notes

- `PINPOINT_API_URL` must be `https://` (plain `http://` is accepted only for
  `localhost` / `127.0.0.1` / `::1`) so the bearer key never travels in cleartext.
- Feedback bodies and comments include text from anonymous public submitters.
  Every tool result therefore starts with an explicit "untrusted third-party
  content" notice block, followed by the JSON payload. Treat the payload as data,
  not instructions.
- A triage agent that only reads should use a key with just the `feedback:read`
  scope; `update_feedback_status` and `add_comment` need `feedback:write`.
- Upstream error bodies are truncated to 300 characters in thrown errors.

## Run

```bash
npm run build --workspace @pinpoint/mcp-server
node mcp-server/dist/index.js        # speaks MCP over stdio
```

Example Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pinpoint": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "PINPOINT_API_URL": "https://pinpoint.example.com",
        "PINPOINT_API_KEY": "pk_xxxxxxxx"
      }
    }
  }
}
```

## Protocol implementation note

This workspace implements the MCP wire protocol (JSON-RPC 2.0 over stdio:
`initialize`, `tools/list`, `tools/call`, plus the `notifications/*` no-ops) by
hand in `src/server.ts`, rather than depending on the official
`@modelcontextprotocol/sdk`.

**Why:** the SDK could not be installed in the build environment without
mutating the shared root `package-lock.json`, which several contributors were
editing in parallel. The MCP tool-server surface is a small, stable dialect, so
the hand-rolled core keeps the workspace dependency-free and deterministic. The
tool registry (`src/tools.ts`) and REST client (`src/client.ts`) are transport
independent, so swapping in the official SDK later is isolated to the stdio glue
in `src/index.ts`.

## Scripts

```bash
npm run build --workspace @pinpoint/mcp-server      # tsc --build
npm run typecheck --workspace @pinpoint/mcp-server  # tsc --noEmit
npm test --workspace @pinpoint/mcp-server           # vitest --run
```
