# Datadog Plugin for Copilot & VS Code

Query your Datadog data directly from Copilot and VS Code using natural language. Ask about logs, metrics, traces, dashboards, monitors, and more.

## What you need

- A [Datadog](https://www.datadoghq.com/) account
- [Visual Studio Code](https://code.visualstudio.com/) (latest version recommended) with the [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension, and/or the [Copilot CLI](https://github.com/features/copilot/cli)

## Getting started

To install using the Copilot CLI:

- Type `copilot plugin install datadog@awesome-copilot`

To install using VS Code:

1. Enter `@agentPlugins datadog` in the search field of the Extensions activity.
2. Select the Datadog plugin and click **Install**.

After installation:

- Run `/ddsetup` in Copilot to connect the plugin to your Datadog account. The agent will guide you through selecting the correct Datadog MCP domain. You can run this again at any time.

### Notes

If you already have the Datadog MCP server registered separately (for example, in `.vscode/mcp.json`), disable or remove it to avoid conflicts.

## Using the plugin

Once connected, just ask the agent anything about your Datadog data:

```
Show me error logs for the "checkout" service from the last hour
```

```
What monitors are currently alerting?
```

```
Find traces for service "api-gateway" with latency > 500ms
```

```
List my dashboards
```

## Can't connect?

**Never connected before?** Run the `/ddsetup` command in Copilot. It will help you provide the correct Datadog MCP domain and set up the MCP server.

**Was working before but stopped?** Run the `/ddconfig` command in Copilot. It will check your site, authentication status, and network access to help diagnose the issue.

## Changing settings

The plugin provides a few commands you can run in the agent to manage configuration:

- `/ddconfig` — change your Datadog site or switch organizations
- `/ddtoolsets` — enable or disable groups of tools

## Advanced usage

### Key authentication

Instead of OAuth, you can authenticate using a Datadog API key and application key.

1. Run `/ddsetup` as usual to configure the MCP domain.
2. Set the following environment variables before starting Copilot / VS Code:

   ```bash
   export DD_API_KEY=your-api-key
   export DD_APPLICATION_KEY=your-application-key
   ```

3. Restart Copilot / VS Code (or reload the MCP server via **`MCP: List Servers`** → Restart Server). The server will use the API keys instead of prompting for OAuth.

> On macOS, launch VS Code from the terminal after exporting the variables, or use a launcher that inherits your shell environment.

## Good to know

- By default, authentication is handled via OAuth in your browser. Key authentication is also [supported](#key-authentication).
- No Datadog credentials are sent to the AI model provider.

## Support

- [Datadog MCP Server Documentation](https://docs.datadoghq.com/mcp_server/)

## Legal

See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files included with this plugin.

For details on how Datadog handles your data, see the [Datadog Privacy Policy](https://www.datadoghq.com/legal/privacy).
