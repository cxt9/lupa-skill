#!/usr/bin/env node
// End-to-end check against the live Lupa API through the MCP protocol.
// Creates a real album in your account. Usage:
//   node scripts/smoke-test.mjs <folder-with-24+-photos> [--cleanup]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const photoDirectory = process.argv[2];
const shouldCleanUp = process.argv.includes("--cleanup");
if (!photoDirectory) {
  console.error("Usage: node scripts/smoke-test.mjs <photo-folder> [--cleanup]");
  process.exit(2);
}

const serverPath = fileURLToPath(new URL("../dist/lupa-mcp.js", import.meta.url));
const client = new Client({ name: "lupa-smoke-test", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

async function callTool(toolName, toolArguments = {}) {
  const startedAt = Date.now();
  const result = await client.callTool({ name: toolName, arguments: toolArguments });
  const text = result.content?.[0]?.text ?? "";
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.isError) throw new Error(`${toolName} failed after ${seconds}s: ${text}`);
  console.log(`ok  ${toolName} (${seconds}s)`);
  return JSON.parse(text);
}

const { tools } = await client.listTools();
console.log(`server exposes ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);

const authStatus = await callTool("lupa_auth_status");
if (!authStatus.logged_in) throw new Error("Not logged in. Run: node dist/lupa-mcp.js login");

const created = await callTool("lupa_create_album", { name: `Smoke ${new Date().toISOString().slice(5, 16)}` });
const eventToken = created.event_token;
console.log("    album:", created.name);

try {
  const upload = await callTool("lupa_upload_photos", { event_token: eventToken, directory: photoDirectory });
  console.log(`    uploaded ${upload.uploaded_count}, failed ${upload.failed_count}, album has ${upload.album_photo_count}`);

  const options = await callTool("lupa_get_book_options", { event_token: eventToken });
  const defaultFormat = options.formats.find((format) => format.is_default) ?? options.formats[0];
  const cover = defaultFormat.covers[0].cover;
  console.log(`    formats: ${options.formats.map((format) => format.format_id).join(", ")}; using cover ${cover}`);

  const themes = await callTool("lupa_list_themes", { event_token: eventToken, cover, density: "magazine" });
  const regularThemes = themes.book_types.find((bookType) => bookType.book_type === "regular");
  const theme = regularThemes?.categories[0]?.themes[0] ?? "white_new";
  console.log(`    ${themes.book_types.length} book types; using theme ${theme}`);

  const generated = await callTool("lupa_generate_book", {
    event_token: eventToken,
    cover,
    density: "magazine",
    direction: "rtl",
    theme,
  });
  console.log(`    status ${generated.status}, ${generated.spreads} spreads`);

  const layout = await callTool("lupa_get_book_layout", { event_token: eventToken });
  const placedPhotos = layout.spreads.reduce((total, spread) => total + spread.photo_count, 0);
  console.log(`    ${layout.spread_count} spreads, ${placedPhotos} photos placed, theme ${layout.theme}`);

  const regenerated = await callTool("lupa_generate_book", {
    event_token: eventToken,
    cover,
    density: "single",
    direction: "ltr",
    theme: "blue_new",
  });
  const relaidOut = await callTool("lupa_get_book_layout", { event_token: eventToken });
  if (relaidOut.direction !== "LTR" || relaidOut.theme !== "blue_new") {
    throw new Error(`Regeneration did not apply: ${relaidOut.direction} ${relaidOut.theme}`);
  }
  console.log(`    regenerated (reopened: ${regenerated.reopened_previous_layout}), ${relaidOut.spread_count} spreads`);

  const albumBefore = await callTool("lupa_get_album", { event_token: eventToken });
  const photoToDelete = albumBefore.photos[0].image_name;
  const guarded = await client.callTool({
    name: "lupa_delete_photo",
    arguments: { event_token: eventToken, image_name: photoToDelete },
  });
  if (!guarded.isError) throw new Error("Deleting from a generated book should require reopen: true");
  console.log("ok  lupa_delete_photo refused on generated book without reopen");
  await callTool("lupa_delete_photo", { event_token: eventToken, image_name: photoToDelete, reopen: true });

  await callTool("lupa_rename_album", { event_token: eventToken, name: "Smoke test renamed" });
  const album = await callTool("lupa_get_album", { event_token: eventToken, include_photos: false });
  console.log(`    renamed to "${album.name}", ${album.photo_count} photos, status ${album.status}`);
  console.log(`    editor: ${generated.editor_url}`);
} finally {
  if (shouldCleanUp) {
    await callTool("lupa_delete_album", { event_token: eventToken });
  }
  await client.close();
}
