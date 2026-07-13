# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through Dev Desktop.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local Dev Desktop server

Dev Desktop does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx @bamn/devdesktop init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through Dev Desktop. Keep this
narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Start your tunnel or reverse proxy before entering this value. Point the tunnel
at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

## Start The Server

Run:

```bash
npx @bamn/devdesktop serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVDESKTOP_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @bamn/devdesktop serve
```

For a stable public URL, persist it:

```bash
npx @bamn/devdesktop config set publicBaseUrl https://devdesktop.example.com
npx @bamn/devdesktop serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, Dev Desktop shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devdesktop/config.json
~/.devdesktop/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @bamn/devdesktop doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing Dev Desktop itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
