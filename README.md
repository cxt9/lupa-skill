# Lupa photo books for Claude

Create printed photo books on [Lupa](https://www.lupa.co.il) (לופה) straight from Claude Code or Claude Desktop / Cowork: point Claude at a folder of photos and it creates the album, uploads the photos, picks a size and design, and has Lupa lay out the book. You then open the book in Lupa's editor, tweak anything you like, and order and pay there.

> **Unofficial.** This project is not affiliated with or endorsed by Lupa. Lupa has no public API; this uses the same internal endpoints as Lupa's own web editor, reverse-engineered in September 2026. It can break whenever Lupa changes their site. Use it with your own account, at your own risk, and in line with Lupa's terms of use.

It contains:

- **An MCP server** (`mcp/`, Node 20+, no dependencies to install) exposing `lupa_*` tools.
- **A skill** (`skills/lupa-photo-album/`) that teaches Claude the workflow: connect, pick photos, upload, choose format and theme, generate, hand over the editor link.
- **A plugin manifest** so Claude Code can install both in one step.

## What it can do

| Tool | What it does |
|---|---|
| `lupa_login`, `lupa_auth_status`, `lupa_logout` | Connect your Lupa account (see [Login](#login)) |
| `lupa_list_albums`, `lupa_get_album` | Your books, their status, photos and editor links |
| `lupa_create_album`, `lupa_rename_album` | Create a book (title printed on the spine), rename it |
| `lupa_upload_photos`, `lupa_delete_photo` | Upload a folder or files (JPEG, PNG, WebP, HEIC on macOS); remove photos |
| `lupa_get_book_options`, `lupa_list_themes` | Sizes, cover types, layouts with photo limits, prices, and design themes |
| `lupa_generate_book` | Lupa's server lays out the book; re-running re-designs it |
| `lupa_get_book_layout` | Which photos landed on which spread |
| `lupa_duplicate_album`, `lupa_delete_album` | Copy or delete a book |

Ordering and payment are deliberately **not** automated: the tools stop at a laid-out book and give you the Lupa editor link, where you review and click "add to cart".

## Install

### Claude Code

```bash
claude plugin marketplace add cxt9/lupa-skill
```

```bash
claude plugin install lupa@lupa-skill
```

Or from inside Claude Code: `/plugin marketplace add cxt9/lupa-skill`, then `/plugin install lupa@lupa-skill`. Restart Claude Code, then ask something like *"Make a Lupa photo book from ~/Pictures/Greece-2026"*.

### Claude Desktop and Cowork

If your Claude app supports plugins, add this repository as a plugin marketplace and install `lupa`, the same as above.

Otherwise, set it up manually:

1. Clone the repo:

   ```bash
   git clone https://github.com/cxt9/lupa-skill.git ~/lupa-skill
   ```

2. Add the MCP server to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart Claude:

   ```json
   {
     "mcpServers": {
       "lupa": {
         "command": "node",
         "args": ["/Users/YOU/lupa-skill/mcp/dist/lupa-mcp.js"]
       }
     }
   }
   ```

3. Add the skill: zip the `skills/lupa-photo-album` folder and upload it under Settings > Capabilities > Skills.

The MCP server runs on your computer, so photo paths you give Claude must be files on that computer.

## Login

Lupa has no API keys or OAuth, so the server borrows the session of your normal browser login. Your password never goes through this tool.

1. Ask Claude to connect Lupa (it calls `lupa_login`), or run `node mcp/dist/lupa-mcp.js login` in a terminal.
2. Log in at <https://online-v3.lupa.co.il> in your browser.
3. Open the browser console on that tab (Mac: Cmd+Option+J) and paste the one-line snippet you were given. It posts the page's session token to a one-time receiver on `127.0.0.1` (protected by a random nonce, closes after use or 10 minutes). If Chrome asks whether the site may access your local network, allow it.

The token is saved to `~/.config/lupa-mcp/auth.json` (permissions `600`) and refreshed automatically. You can also provide it through the `LUPA_TOKEN` environment variable. `lupa-mcp logout` deletes it.

**Nothing secret is stored in this repository.** The token only ever lives in that local file (or your environment).

## How it works

The flow mirrors Lupa's web wizard:

1. `updatealbum` creates the album and returns its `event_token`.
2. Photos are posted one by one to `upload.lupa.co.il`.
3. `albumthemescategories` builds a draft book for the chosen cover, density and direction.
4. `closealbum3` applies the theme and generates the book, and `albumprogress` is polled until it's done.

Full notes on endpoints, parameters, statuses and the layout-tree format are in [skills/lupa-photo-album/references/api.md](skills/lupa-photo-album/references/api.md).

## Development

```bash
cd mcp
npm install
npm run typecheck
npm run build
```

`npm run build` bundles everything into `mcp/dist/lupa-mcp.js`, which is committed so the plugin works without `npm install`.

End-to-end test against your real account (creates an album, uploads photos, generates it twice, and with `--cleanup` deletes it again):

```bash
node mcp/scripts/smoke-test.mjs /path/to/24-or-more-photos --cleanup
```

## License

MIT
