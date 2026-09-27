---
name: lupa-photo-album
description: Create printed photo books (albums) on Lupa (lupa.co.il, "לופה") from local photos. Use when the user wants to make, build, design or print a photo book, photo album, "אלבום", "ספר תמונות" or "לופה", wants to turn a folder of photos (trip, family, event, year) into a Lupa book, or asks to list, check, rename or re-design their existing Lupa albums. Requires the `lupa` MCP server from this plugin.
---

# Lupa photo books

Lupa is an Israeli photo book printing service. This skill drives its web editor's (unofficial) API through the `lupa` MCP server tools (`lupa_*`). Claude handles the tedious part: picking and uploading photos, choosing size and design, and getting a laid-out book. The user reviews the result in Lupa's editor and orders and pays there themselves.

## Ground rules

- **Never ask for or type the user's Lupa password.** Connecting uses `lupa_login` (see below).
- **Never try to order or pay.** Ordering renders pages in the browser and payment happens on Lupa's checkout. Finish by giving the user the `editor_url`.
- **Confirm before anything destructive or lossy:** deleting an album (`lupa_delete_album`), deleting photos, or reopening/re-generating a book that is already generated (this discards its layout and any manual edits the user made in the editor). State the album name when asking.
- The API is reverse-engineered and can break. If a tool fails in an unexpected way, report the error text to the user instead of retrying in a loop.

## 1. Connect (once per machine)

Call `lupa_auth_status`. If `logged_in` is false, call `lupa_login` and show the user its steps and `console_snippet` in a code block:

1. Open https://online-v3.lupa.co.il and log in normally.
2. Open the browser console on that tab (Mac: Cmd+Option+J) and paste the snippet. It sends the site's session token to the local MCP server on 127.0.0.1 only.
3. Tell Claude when the console prints "Lupa connected", then call `lupa_auth_status` again.

If the Claude in Chrome tools are available and the user is logged in to Lupa in that browser, you may offer to run the snippet in their Lupa tab for them, but only after they say yes. The session is saved to `~/.config/lupa-mcp/auth.json` and refreshed automatically.

## Paths (important in Cowork)

The `lupa` MCP server runs directly on the user's computer, not in Claude's sandbox. Always give `lupa_upload_photos` the photo folder's **real path on the computer** (for example `/Users/<name>/Pictures/Greece 2026`).

In Cowork, a folder the user shares also appears inside the sandbox as `/sessions/<vm-name>/mnt/<folder name>`. You can use that sandbox path to look at or pre-select photos, but translate it back to the computer path before uploading: for a curated subset, pass `paths` as `<computer folder>/<file name>`. If you don't know the folder's location on the computer, ask the user (in Finder: right-click the folder, hold Option, "Copy ... as Pathname").

## 2. Gather what the book needs

Before creating anything, make sure you know:

- **Photos**: a folder or list of files on this machine. A book needs **at least 24 photos**; limits per layout are returned by `lupa_get_book_options` (commonly up to 864). Supported: JPEG, PNG, WebP, and HEIC (converted on macOS).
- **Title**: 2 to 28 characters, printed on the spine (can be renamed later).
- **Size and cover**, **layout density**, **direction** and **theme**. Suggest sensible defaults and let the user adjust (see the table below) rather than asking five separate questions.

If the user gives a large folder and wants a curated book, help select photos first: skip near-duplicates, screenshots, blurry or irrelevant images, keep chronological order (sort by file name or EXIF date), and aim for a count that suits the chosen density. Show the user the selection summary (count, date range, anything excluded and why) before uploading. When you can view images, look at a sample rather than guessing from file names.

## 3. Build the book

1. `lupa_create_album` with the title. Keep the returned `event_token`.
2. `lupa_upload_photos` with `directory` and/or `paths`. Report uploaded and failed counts. Original files are uploaded as-is (with their EXIF data); Lupa decides the photo order in the generated book, and the user can reorder in the editor.
3. `lupa_get_book_options` to get the real formats, `cover` ids, densities with photo limits, and starting prices. Present the relevant options briefly.
4. `lupa_list_themes` for the chosen cover, density and direction. `regular` book type = solid colour themes (e.g. `white_new`, `black_new`, `blue_new`); `coffee_table` ("lupart") = illustrated designs (travel cities, love, years, flowers, numbers) and supports only the `magazine` density.
5. `lupa_generate_book` with `cover`, `density`, `direction`, `theme`. It waits for Lupa's server to lay out the book (usually 10 to 30 seconds).
6. Optionally `lupa_get_book_layout` to check photo distribution per spread (e.g. all photos placed, no near-empty spreads).
7. Give the user the `editor_url` and tell them: review the pages, adjust anything they like (swap photos, change layouts, edit texts), then click the green add-to-cart button ("הוספה לסל") to order and pay.

### Choosing settings

| Setting | Values | Default suggestion |
|---|---|---|
| cover | e.g. `square_normal` (20x20 hard/soft), `square_large_normal` (30x30), `panoramic_normal`, `classic_normal`; `*_layflat` = premium lay-flat pages, fewer photos max | `square_normal` for a casual book, `square_large_normal` for a showcase |
| density | `multiple` (up to 6 photos per page, lively), `magazine` (styled mixed layouts), `single` (one photo per page, needs fewer photos: small square allows up to 144) | `magazine` |
| direction | `rtl` (opens from the right, Hebrew) or `ltr` | `rtl` if the user writes in Hebrew or the title is Hebrew, else ask |
| theme | from `lupa_list_themes` | `white_new` |

Always use the ids returned by the tools; the table is only a guide.

## Existing albums

- `lupa_list_albums` shows each album's status: `OPEN` = photos can change, not yet laid out; `CLOSED` = laid out (generated); `in_basket` = already in the cart.
- To add or remove photos in a `CLOSED` book, the tools require `reopen: true`. Explain that this resets the layout (manual edits are lost), get agreement, then re-run `lupa_generate_book`.
- `lupa_duplicate_album` makes an editable copy (up to 3 per album), a safe way to experiment with a different design.

## Troubleshooting

- "Not logged in" or "session expired": run the connect step again.
- `ERROR_NOT_FORMAT_PROPERTY`: the `cover` value is wrong; use a `cover` id from `lupa_get_book_options`, not the format id.
- Too many or too few photos for a density: pick another density or cover, or add or remove photos.
- Generation still running after `wait_seconds`: call `lupa_get_album` later and check `generation_status`.

For the underlying HTTP API (endpoints, parameters, statuses), see [references/api.md](references/api.md).
