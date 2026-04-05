# MCP Servers

Kraken connects to [Model Context Protocol](https://modelcontextprotocol.io) servers, extending the agent with external tools. MCP tools are automatically available alongside built-in tools during conversations and worker execution.

---

## Configuration

Add servers under the `mcp` key in `kraken.jsonc`:

```jsonc
{
  "mcp": {
    "sqlite": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-sqlite", "db.sqlite"],
      "enabled": true
    },
    "remote-tools": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "Bearer ${MCP_API_KEY}" }
    }
  }
}
```

---

## Server types

### Local (stdio)

Spawns a process and communicates via stdin/stdout.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | `"local"` |
| `command` | string[] | yes | Command and arguments to spawn |
| `environment` | object | no | Extra environment variables |
| `enabled` | boolean | no | Default: `true` |
| `timeout` | number | no | Connection timeout in ms (default: 30000) |

### Remote (HTTP/SSE)

Connects to an HTTP server using StreamableHTTP or SSE transport.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | `"remote"` |
| `url` | string | yes | Server URL |
| `headers` | object | no | HTTP headers (`${ENV_VAR}` syntax supported) |
| `enabled` | boolean | no | Default: `true` |
| `timeout` | number | no | Connection timeout in ms (default: 30000) |

---

## CLI management

```bash
kraken mcp list
kraken mcp add myserver --command "npx -y @modelcontextprotocol/server-sqlite db.sqlite"
kraken mcp add remote --url https://mcp.example.com
kraken mcp remove myserver
kraken mcp enable myserver
kraken mcp disable myserver
```
