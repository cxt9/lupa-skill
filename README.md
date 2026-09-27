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

**Requirements:** [Node.js](https://nodejs.org) 20 or newer on your computer (the Lupa server is a small Node program), and a Lupa account. Cowork plugins need a paid Claude plan (Pro, Max, Team or Enterprise).

### Claude Cowork (desktop app)

1. Open the **Cowork** tab in the Claude desktop app.
2. Open **Customize** in the sidebar, then **Plugins**.
3. Select **Add marketplace** (under **Add**), choose **Add from a repository**, and enter:

   ```
   cxt9/lupa-skill
   ```

4. Find **lupa** in the plugin list (under **Discover**, or in the `lupa-skill` marketplace) and click **Install**.
5. Open the installed **lupa** plugin and go to its **Connectors** tab. If the `lupa` connector isn't connected yet, add or enable it there (installing a plugin doesn't turn its connectors on by itself). It's a local connector, so there's no sign-in on this screen; you connect your Lupa account in your first chat (see [Login](#login)).

Then start a Cowork task, share the folder with your photos, and ask for example:

> Make a Lupa photo book from my "Greece 2026" folder. Pick the best 60 photos, big square, magazine style, opening from the right.

Claude will ask you to connect Lupa the first time, suggest a size and design, upload the photos, lay out the book, and give you a link to review and order it in Lupa's editor.

Good to know in Cowork:

- **The Lupa server runs on your computer**, not in Cowork's sandbox. When Claude uploads, it needs the folder's real location on your Mac (like `/Users/you/Pictures/Greece 2026`). If Claude asks for it, right-click the folder in Finder, hold Option, and choose **Copy "..." as Pathname**.
- **Updates:** on the Plugins page, use **Check for updates** on the `lupa-skill` marketplace, or turn on **Sync automatically**.
- If your organization is on a Team or Enterprise plan, an admin may have restricted custom plugins or local connectors.

### Claude Code

```bash
claude plugin marketplace add cxt9/lupa-skill
```

```bash
claude plugin install lupa@lupa-skill
```

Or from inside Claude Code: `/plugin marketplace add cxt9/lupa-skill`, then `/plugin install lupa@lupa-skill`. Start a new session, then ask something like *"Make a Lupa photo book from ~/Pictures/Greece-2026"*. This also works in the **Code** tab of the Claude desktop app.

### Manual setup (other MCP clients)

1. Clone the repo:

   ```bash
   git clone https://github.com/cxt9/lupa-skill.git ~/lupa-skill
   ```

2. Register the MCP server in your client. For example, for the Claude desktop app's chat, in `~/Library/Application Support/Claude/claude_desktop_config.json` (then restart the app):

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

3. If your client supports skills, add `skills/lupa-photo-album` (for Claude, zip the folder and upload it as a skill).

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
