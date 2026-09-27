import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AUTH_FILE_PATH, clearAuth, loadAuth } from "./auth.js";
import { LupaClient, LupaError } from "./client.js";
import {
  CONVERTIBLE_EXTENSIONS,
  editorUrl,
  MAX_ALBUM_NAME_LENGTH,
  MIN_PHOTOS_PER_ALBUM,
  photoStackUrl,
  PROGRESS_COMPLETE_STATUSES,
  PROGRESS_ERROR_STATUSES,
  SUPPORTED_UPLOAD_EXTENSIONS,
  WEB_EDITOR_ORIGIN,
} from "./config.js";
import { startLoginSession, verifyToken } from "./login.js";

// ---------- Response shapes (only the fields we use) ----------

interface AlbumRecord {
  album_id: number;
  event_token: string;
  name: string;
  event_status: string;
  event_type: string;
  category?: string;
  image_count: number;
  image_min?: number;
  image_max?: number;
  page_count?: number;
  density?: string;
  format?: string;
  book_direction?: string;
  skin?: string;
  in_basket?: boolean;
  insert_date_utc?: string;
  update_date_utc?: string;
  img_arr?: Array<{
    uniqueId: number;
    image_name: string;
    imageOriginalWidth?: number;
    imageOriginalHeight?: number;
    insert_date?: string;
  }>;
}

interface DensityOption {
  id: string;
  title: string;
  layout?: string;
  image_min: number;
  image_max: number;
}

interface CoverOption {
  id: string;
  title: string;
  description?: string;
  price_description?: string;
  image_max: number;
  temporary_disabled?: boolean;
  densities?: DensityOption[];
}

interface FormatOption {
  id: string;
  title: string;
  size_horizontal: number;
  size_vertical: number;
  format_default?: boolean;
  unavailable?: boolean;
  covers: CoverOption[];
}

interface BookFormatsPayload {
  formats: FormatOption[];
  bookDirections: Array<{ id: string; title: string }>;
  cover_families: Array<{ id: string; title: string }>;
}

interface ThemesPayload {
  designsNew: Array<{
    id: string;
    title: string;
    description?: string;
    custom_settings?: { densities?: string[] } | null;
    categories: Array<{ id: string; title: string; themes: Array<{ id: string }> }>;
  }>;
}

interface ProgressPayload {
  progress_status: string;
  error_code: number;
  name: string;
}

interface TreeFolder {
  m_folderID: number;
  m_type?: string;
  m_layoutID?: number;
  m_child_folders?: Array<TreeFolder | null> | null;
}

interface TreeImage {
  m_folderID: number;
  m_image_name: string;
  m_unique_id: number;
}

interface TreeSubtree {
  m_spread_folders: TreeFolder[];
  m_tree_tmages: TreeImage[];
  m_tree_texts?: unknown;
}

interface TreePayload {
  m_treeMessage: {
    m_treeV5: {
      m_album_name: string;
      m_album_theme: string;
      m_album_direction: string;
      m_book_type: string;
      m_cover_type: string;
      m_format: number;
      m_book_subtree: TreeSubtree;
      m_cover_subtree: TreeSubtree;
    };
  };
}

// ---------- Helpers ----------

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(caughtError: unknown) {
  const message =
    caughtError instanceof LupaError || caughtError instanceof Error
      ? caughtError.message
      : String(caughtError);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function summarizeAlbum(album: AlbumRecord) {
  return {
    name: album.name,
    event_token: album.event_token,
    status: album.event_status,
    photo_count: album.image_count,
    page_count: album.page_count,
    density: album.density,
    format: album.format,
    direction: album.book_direction,
    theme: album.skin,
    in_basket: album.in_basket,
    created_utc: album.insert_date_utc,
    updated_utc: album.update_date_utc,
    editor_url: editorUrl(album.event_token),
  };
}

const eventTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/i, "An album event_token is 32 hex characters (see lupa_list_albums)")
  .describe("The album's event_token from lupa_list_albums or lupa_create_album");

async function collectPhotoPaths(
  paths: string[] | undefined,
  directory: string | undefined,
  recursive: boolean,
): Promise<string[]> {
  const acceptedExtensions = [...SUPPORTED_UPLOAD_EXTENSIONS, ...CONVERTIBLE_EXTENSIONS];
  const collectedPaths: string[] = [];

  const walkDirectory = async (directoryPath: string) => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory() && recursive) await walkDirectory(entryPath);
      if (entry.isFile() && acceptedExtensions.includes(extname(entry.name).toLowerCase())) {
        collectedPaths.push(entryPath);
      }
    }
  };

  if (directory) {
    const directoryPath = resolve(directory);
    if (!(await stat(directoryPath)).isDirectory()) throw new LupaError(`Not a directory: ${directory}`);
    await walkDirectory(directoryPath);
  }
  for (const filePath of paths ?? []) collectedPaths.push(resolve(filePath));
  return [...new Set(collectedPaths)];
}

async function fetchAlbum(client: LupaClient, eventToken: string): Promise<AlbumRecord> {
  return client.api<AlbumRecord>("albumsByEventToken", { event_token: eventToken, show_basket: "true" });
}

const GENERATED_ALBUM_STATUS = "CLOSED";

/**
 * A generated book is "CLOSED": Lupa refuses photo changes and ignores re-generation until
 * it is reopened, and reopening throws away the current layout (and manual edits).
 */
async function ensureAlbumOpen(client: LupaClient, album: AlbumRecord, allowReopen: boolean): Promise<boolean> {
  if (album.event_status !== GENERATED_ALBUM_STATUS) return false;
  if (!allowReopen) {
    throw new LupaError(
      `"${album.name}" already has a generated layout. Changing its photos means reopening it, which discards the ` +
        "current layout and any manual edits made in the web editor; afterwards run lupa_generate_book again. " +
        "Ask the user, then retry with reopen: true.",
    );
  }
  await client.api("reopenalbum", { event_token: album.event_token });
  return true;
}

/**
 * albumthemescategories is more than a catalogue: it also builds the draft book ("smartbook")
 * for these settings, which closealbum3 then finalizes. The web wizard always calls it first.
 */
async function fetchThemesAndPrepareDraft(
  client: LupaClient,
  eventToken: string,
  photoCount: number,
  cover: string,
  density: string,
  direction: string,
): Promise<ThemesPayload> {
  return client.api<ThemesPayload>("albumthemescategories", {
    image_count: photoCount,
    lang: "en",
    event_token: eventToken,
    format: cover,
    direction: direction.toUpperCase(),
    layout: density === "magazine" ? "layout_c" : undefined,
  });
}

function findCover(formats: FormatOption[], coverId: string) {
  for (const format of formats) {
    const cover = format.covers.find((candidateCover) => candidateCover.id === coverId);
    if (cover) return { format, cover };
  }
  return undefined;
}

/**
 * Maps each spread to the photos placed in it. The tree nests
 * spread -> page regions (RIGHT_REGION_TYPE / LEFT_REGION_TYPE) -> IMAGE_TYPE slots,
 * and photos are linked to slots by m_folderID. Some child entries are null.
 */
function summarizeSubtree(subtree: TreeSubtree) {
  const imagesByFolderId = new Map(
    (subtree.m_tree_tmages ?? []).filter(Boolean).map((image) => [image.m_folderID, image]),
  );
  const collectPhotos = (folder: TreeFolder | null, photoNames: string[]) => {
    if (!folder) return photoNames;
    const image = imagesByFolderId.get(folder.m_folderID);
    if (image) photoNames.push(image.m_image_name);
    for (const childFolder of folder.m_child_folders ?? []) collectPhotos(childFolder, photoNames);
    return photoNames;
  };
  return (subtree.m_spread_folders ?? []).filter(Boolean).map((spread, spreadIndex) => {
    const pages = (spread.m_child_folders ?? [])
      .filter((childFolder): childFolder is TreeFolder => Boolean(childFolder?.m_type?.endsWith("REGION_TYPE")))
      .map((region) => ({
        side: region.m_type === "RIGHT_REGION_TYPE" ? "right" : region.m_type === "LEFT_REGION_TYPE" ? "left" : region.m_type,
        layout_id: region.m_layoutID,
        photos: collectPhotos(region, []),
      }));
    const photos = collectPhotos(spread, []);
    return {
      spread_index: spreadIndex,
      type: spread.m_type,
      photo_count: photos.length,
      pages: pages.length ? pages : undefined,
      photos: pages.length ? undefined : photos,
    };
  });
}

// ---------- Tool registration ----------

export function registerTools(server: McpServer, client: LupaClient): void {
  server.registerTool(
    "lupa_login",
    {
      title: "Connect Lupa account",
      description:
        "Starts a one-time local login receiver and returns a JavaScript snippet. The user logs in at " +
        `${WEB_EDITOR_ORIGIN} in their own browser, opens DevTools > Console on that tab, and pastes the ` +
        "snippet. It sends the site's session token to this machine only (127.0.0.1). Never ask the user for " +
        "their Lupa password. Afterwards call lupa_auth_status to confirm.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const session = await startLoginSession();
        session.completion.then(() => client.resetCachedAuth()).catch(() => {});
        return jsonResult({
          steps: [
            `Open ${WEB_EDITOR_ORIGIN} in your browser and log in to Lupa (if you are not already).`,
            "Open the browser's developer console on that tab (Mac: Cmd+Option+J, Windows: Ctrl+Shift+J).",
            "Paste the snippet below and press Enter. If Chrome asks to allow access to devices on your local network, allow it.",
            "The console should print 'Lupa connected'. Then tell Claude you're done.",
          ],
          console_snippet: session.consoleSnippet,
          listening_on: `127.0.0.1:${session.port}`,
          expires_in_minutes: 10,
          token_saved_to: AUTH_FILE_PATH,
        });
      } catch (loginError) {
        return errorResult(loginError);
      }
    },
  );

  server.registerTool(
    "lupa_auth_status",
    {
      title: "Check Lupa login",
      description: "Checks whether a valid Lupa session is saved on this machine.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        client.resetCachedAuth();
        const storedAuth = await loadAuth();
        if (!storedAuth) return jsonResult({ logged_in: false, how_to_fix: "Call lupa_login." });
        try {
          const firstName = await verifyToken(await client.getToken());
          return jsonResult({ logged_in: true, account_name: firstName ?? null });
        } catch {
          if (await client.refreshToken()) return jsonResult({ logged_in: true, refreshed: true });
          return jsonResult({ logged_in: false, how_to_fix: "The saved session expired. Call lupa_login." });
        }
      } catch (statusError) {
        return errorResult(statusError);
      }
    },
  );

  server.registerTool(
    "lupa_logout",
    {
      title: "Disconnect Lupa account",
      description: "Deletes the saved Lupa session token from this machine.",
      inputSchema: {},
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      await clearAuth();
      client.resetCachedAuth();
      return jsonResult({ logged_out: true, removed: AUTH_FILE_PATH });
    },
  );

  server.registerTool(
    "lupa_list_albums",
    {
      title: "List Lupa albums",
      description:
        "Lists the user's Lupa photo books (albums) with status, photo and page counts, and a link to open each one in the Lupa web editor.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const albums = await client.api<AlbumRecord[]>("userAlbums", { device_type: "desktop" });
        return jsonResult({ albums: (albums ?? []).map(summarizeAlbum) });
      } catch (listError) {
        return errorResult(listError);
      }
    },
  );

  server.registerTool(
    "lupa_get_album",
    {
      title: "Get Lupa album details",
      description:
        "Returns details for one album: status, settings, generation progress, and the uploaded photos (image_name, size).",
      inputSchema: {
        event_token: eventTokenSchema,
        include_photos: z.boolean().default(true).describe("Include the list of uploaded photos"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ event_token, include_photos }) => {
      try {
        const album = await fetchAlbum(client, event_token);
        let progress: ProgressPayload | null = null;
        try {
          progress = await client.api<ProgressPayload>("albumprogress", { event_token });
        } catch {
          progress = null; // No generated book yet.
        }
        return jsonResult({
          ...summarizeAlbum(album),
          min_photos: album.image_min ?? MIN_PHOTOS_PER_ALBUM,
          max_photos: album.image_max,
          generation_status: progress?.progress_status ?? "NOT_GENERATED",
          photos: include_photos
            ? (album.img_arr ?? []).map((photo) => ({
                image_name: photo.image_name,
                unique_id: photo.uniqueId,
                width: photo.imageOriginalWidth,
                height: photo.imageOriginalHeight,
                uploaded: photo.insert_date,
              }))
            : undefined,
        });
      } catch (getError) {
        return errorResult(getError);
      }
    },
  );

  server.registerTool(
    "lupa_create_album",
    {
      title: "Create Lupa album",
      description:
        `Creates a new empty photo book. The name is printed on the spine (2 to ${MAX_ALBUM_NAME_LENGTH} characters, ` +
        "can be changed later). Next: lupa_upload_photos, then lupa_get_book_options and lupa_generate_book.",
      inputSchema: {
        name: z.string().trim().min(2).max(MAX_ALBUM_NAME_LENGTH).describe("Book title, printed on the spine"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const payload = await client.api<AlbumRecord | { album?: AlbumRecord }>("updatealbum", {
          album_name: name,
          event_type: "REGULAR",
          flipbook_new: "true",
          lang: "he",
        });
        const album = (payload && "event_token" in payload ? payload : (payload as { album?: AlbumRecord })?.album) as
          | AlbumRecord
          | undefined;
        if (!album?.event_token) {
          throw new LupaError("Album was created but Lupa's response had no event_token. Check lupa_list_albums.");
        }
        return jsonResult({
          created: true,
          name: album.name ?? name,
          event_token: album.event_token,
          min_photos: album.image_min ?? MIN_PHOTOS_PER_ALBUM,
          max_photos: album.image_max,
          photos_page_url: photoStackUrl(album.event_token),
        });
      } catch (createError) {
        return errorResult(createError);
      }
    },
  );

  server.registerTool(
    "lupa_rename_album",
    {
      title: "Rename Lupa album",
      description: "Changes the book title (printed on the spine).",
      inputSchema: {
        event_token: eventTokenSchema,
        name: z.string().trim().min(2).max(MAX_ALBUM_NAME_LENGTH),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ event_token, name }) => {
      try {
        await client.api("updatealbum", { album_name: name, event_token, no_resp: "true", tree_resp: "true" });
        return jsonResult({ renamed: true, name });
      } catch (renameError) {
        return errorResult(renameError);
      }
    },
  );

  server.registerTool(
    "lupa_upload_photos",
    {
      title: "Upload photos to Lupa album",
      description:
        "Uploads local photos (JPEG, PNG, WebP; HEIC is converted on macOS) into an album. Pass a directory, a list of " +
        `file paths, or both. A book needs at least ${MIN_PHOTOS_PER_ALBUM} photos. Originals are sent as-is, with EXIF. ` +
        "Uploading does not change an already generated book; run lupa_generate_book again afterwards.",
      inputSchema: {
        event_token: eventTokenSchema,
        directory: z.string().optional().describe("Folder with photos (sorted by file name)"),
        paths: z.array(z.string()).optional().describe("Individual photo file paths"),
        recursive: z.boolean().default(false).describe("Also include photos in sub-folders of directory"),
        concurrency: z.number().int().min(1).max(8).default(4).describe("Parallel uploads"),
        reopen: z
          .boolean()
          .default(false)
          .describe("Allow reopening an already generated book (discards its layout). Ask the user first."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ event_token, directory, paths, recursive, concurrency, reopen }) => {
      try {
        const photoPaths = await collectPhotoPaths(paths, directory, recursive);
        if (photoPaths.length === 0) throw new LupaError("No supported photos found to upload.");
        await ensureAlbumOpen(client, await fetchAlbum(client, event_token), reopen);
        const { uploaded, failed } = await client.uploadPhotos(event_token, photoPaths, concurrency);
        const album = await fetchAlbum(client, event_token);
        const minimumPhotos = album.image_min ?? MIN_PHOTOS_PER_ALBUM;
        return jsonResult({
          uploaded_count: uploaded.length,
          failed_count: failed.length,
          failed,
          album_photo_count: album.image_count,
          ready_to_generate: album.image_count >= minimumPhotos,
          note:
            album.image_count < minimumPhotos
              ? `The album needs at least ${minimumPhotos} photos before a book can be generated.`
              : undefined,
          uploaded: uploaded.map((photo) => ({ file: photo.file, image_name: photo.imageName })),
        });
      } catch (uploadError) {
        return errorResult(uploadError);
      }
    },
  );

  server.registerTool(
    "lupa_delete_photo",
    {
      title: "Delete photo from Lupa album",
      description: "Removes one uploaded photo (by image_name from lupa_get_album) from an album.",
      inputSchema: {
        event_token: eventTokenSchema,
        image_name: z.string().describe("image_name from lupa_get_album, e.g. 0123abcd....jpg"),
        reopen: z
          .boolean()
          .default(false)
          .describe("Allow reopening an already generated book (discards its layout). Ask the user first."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ event_token, image_name, reopen }) => {
      try {
        await ensureAlbumOpen(client, await fetchAlbum(client, event_token), reopen);
        await client.api("deleteImage", { event_token, image_name });
        return jsonResult({ deleted: true, image_name });
      } catch (deleteError) {
        return errorResult(deleteError);
      }
    },
  );

  server.registerTool(
    "lupa_get_book_options",
    {
      title: "List book formats, covers and layouts",
      description:
        "Lists the available book formats (sizes), cover types (use the cover id, e.g. square_normal, as `cover` in " +
        "lupa_generate_book), photo-density layouts with their photo limits, directions and starting prices.",
      inputSchema: {
        event_token: eventTokenSchema,
        lang: z.enum(["en", "he"]).default("en").describe("Language of the titles"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ event_token, lang }) => {
      try {
        const payload = await client.api<BookFormatsPayload>("getbookformats", { event_token, lang });
        return jsonResult({
          formats: payload.formats
            .filter((format) => !format.unavailable)
            .map((format) => ({
              format_id: format.id,
              title: format.title,
              size_cm: `${format.size_horizontal}x${format.size_vertical}`,
              is_default: Boolean(format.format_default),
              covers: format.covers
                .filter((cover) => !cover.temporary_disabled)
                .map((cover) => ({
                  cover: cover.id,
                  title: cover.title,
                  description: cover.description,
                  price: cover.price_description,
                  densities: (cover.densities ?? []).map((density) => ({
                    density: density.id,
                    title: density.title,
                    min_photos: density.image_min,
                    max_photos: density.image_max,
                  })),
                })),
            })),
          directions: payload.bookDirections.map((direction) => ({ direction: direction.id, title: direction.title })),
          book_types: payload.cover_families.map((family) => ({ book_type: family.id, title: family.title })),
        });
      } catch (optionsError) {
        return errorResult(optionsError);
      }
    },
  );

  server.registerTool(
    "lupa_list_themes",
    {
      title: "List book themes",
      description:
        "Lists the design themes available for a chosen cover and layout. `regular` themes are solid colours " +
        "(e.g. white_new); `coffee_table` (lupart) themes are illustrated designs (travel, love, years, flowers...).",
      inputSchema: {
        event_token: eventTokenSchema,
        cover: z.string().describe("Cover id from lupa_get_book_options, e.g. square_normal"),
        density: z.enum(["multiple", "magazine", "single"]).default("magazine"),
        direction: z.enum(["rtl", "ltr"]).default("rtl"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ event_token, cover, density, direction }) => {
      try {
        const album = await fetchAlbum(client, event_token);
        const payload = await fetchThemesAndPrepareDraft(
          client,
          event_token,
          album.image_count,
          cover,
          density,
          direction,
        );
        return jsonResult({
          book_types: payload.designsNew.map((family) => ({
            book_type: family.id,
            title: family.title,
            allowed_densities: family.custom_settings?.densities ?? ["multiple", "magazine", "single"],
            categories: family.categories.map((category) => ({
              category: category.id,
              title: category.title,
              themes: category.themes.map((theme) => theme.id),
            })),
          })),
        });
      } catch (themesError) {
        return errorResult(themesError);
      }
    },
  );

  server.registerTool(
    "lupa_generate_book",
    {
      title: "Generate the photo book layout",
      description:
        "Asks Lupa's server to auto-design the book from the uploaded photos with the chosen cover, layout density, " +
        "direction and theme, then waits for it to finish. If the book was already generated it is reopened and " +
        "laid out again from scratch, so manual edits made in the web editor are lost: confirm with the user first. " +
        "Returns the editor link where the user reviews and orders.",
      inputSchema: {
        event_token: eventTokenSchema,
        cover: z.string().describe("Cover id from lupa_get_book_options, e.g. square_normal or classic_layflat"),
        density: z
          .enum(["multiple", "magazine", "single"])
          .default("magazine")
          .describe("multiple = many photos per page, magazine = mixed styled layouts, single = one photo per page"),
        direction: z.enum(["rtl", "ltr"]).default("rtl").describe("rtl opens from the right (Hebrew), ltr from the left"),
        theme: z.string().default("white_new").describe("Theme id from lupa_list_themes"),
        wait_seconds: z.number().int().min(0).max(600).default(180).describe("How long to wait for generation"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ event_token, cover, density, direction, theme, wait_seconds }) => {
      try {
        const album = await fetchAlbum(client, event_token);
        const bookFormats = await client.api<BookFormatsPayload>("getbookformats", { event_token, lang: "en" });
        const coverMatch = findCover(bookFormats.formats, cover);
        if (!coverMatch) {
          throw new LupaError(`Unknown cover '${cover}'. Pick a cover id from lupa_get_book_options.`);
        }
        const densityOption = coverMatch.cover.densities?.find((option) => option.id === density);
        if (densityOption) {
          if (album.image_count < densityOption.image_min) {
            throw new LupaError(
              `The album has ${album.image_count} photos; '${density}' on ${cover} needs at least ${densityOption.image_min}.`,
            );
          }
          if (album.image_count > densityOption.image_max) {
            throw new LupaError(
              `The album has ${album.image_count} photos; '${density}' on ${cover} allows at most ${densityOption.image_max}. ` +
                "Choose a denser layout, a different cover, or remove photos.",
            );
          }
        }

        const reopened = await ensureAlbumOpen(client, album, true);
        const themes = await fetchThemesAndPrepareDraft(
          client,
          event_token,
          album.image_count,
          cover,
          density,
          direction,
        );
        const themeFamily = themes.designsNew.find((family) =>
          family.categories.some((category) => category.themes.some((candidate) => candidate.id === theme)),
        );
        if (!themeFamily) {
          throw new LupaError(`Unknown theme '${theme}' for ${cover}. Pick one from lupa_list_themes.`);
        }
        const allowedDensities = themeFamily.custom_settings?.densities;
        if (allowedDensities?.length && !allowedDensities.includes(density)) {
          throw new LupaError(
            `Theme '${theme}' (${themeFamily.id}) only supports density ${allowedDensities.join(" or ")}.`,
          );
        }

        await client.api(
          "closealbum3",
          {
            event_token,
            lang: "he",
            format: cover,
            density,
            direction: direction.toUpperCase(),
            album_theme: theme,
            is_cover_edited: "false",
            flipbook_new: "true",
            layout: density === "magazine" ? "layout_c" : undefined,
          },
          { method: "POST", body: new URLSearchParams() },
        );

        const deadline = Date.now() + wait_seconds * 1000;
        let status = "SUBMITTED";
        while (Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
          try {
            const progress = await client.api<ProgressPayload>("albumprogress", { event_token });
            status = progress.progress_status;
          } catch (progressError) {
            // Right after submission Lupa answers ERROR_EVENT_SMARTBOOK_NOT_EXIST for a few seconds.
            if (!(progressError instanceof LupaError) || progressError.errorCode !== "ERROR_EVENT_SMARTBOOK_NOT_EXIST") {
              throw progressError;
            }
          }
          if (PROGRESS_COMPLETE_STATUSES.some((doneStatus) => status.startsWith(doneStatus))) break;
          if (PROGRESS_ERROR_STATUSES.some((failedStatus) => status.startsWith(failedStatus))) {
            throw new LupaError(`Lupa failed to generate the book (status ${status}).`);
          }
        }

        const isDone = PROGRESS_COMPLETE_STATUSES.some((doneStatus) => status.startsWith(doneStatus));
        let spreadCount: number | undefined;
        if (isDone) {
          const tree = await client.editorApi<TreePayload>("gettreelayouts3", event_token);
          spreadCount = tree.m_treeMessage.m_treeV5.m_book_subtree.m_spread_folders.length;
        }
        return jsonResult({
          status,
          done: isDone,
          reopened_previous_layout: reopened,
          spreads: spreadCount,
          settings: { format: coverMatch.format.id, cover, density, direction, theme },
          editor_url: editorUrl(event_token),
          next_step: isDone
            ? "Open editor_url to review the book, tweak pages, and click the add-to-cart button to order and pay on Lupa."
            : "Still generating. Call lupa_get_album later to check generation_status.",
        });
      } catch (generateError) {
        return errorResult(generateError);
      }
    },
  );

  server.registerTool(
    "lupa_get_book_layout",
    {
      title: "Get generated book layout",
      description:
        "Summarizes the generated book: theme, cover type, and for each spread which photos (image_name) it contains. " +
        "Use it to review photo distribution before the user opens the editor.",
      inputSchema: { event_token: eventTokenSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ event_token }) => {
      try {
        const tree = await client.editorApi<TreePayload>("gettreelayouts3", event_token);
        const bookTree = tree.m_treeMessage.m_treeV5;
        const spreads = summarizeSubtree(bookTree.m_book_subtree);
        return jsonResult({
          name: bookTree.m_album_name,
          theme: bookTree.m_album_theme,
          direction: bookTree.m_album_direction,
          book_type: bookTree.m_book_type,
          cover_type: bookTree.m_cover_type,
          format_index: bookTree.m_format,
          spread_count: spreads.length,
          cover_photos: summarizeSubtree(bookTree.m_cover_subtree).flatMap(
            (spread) => spread.photos ?? spread.pages?.flatMap((page) => page.photos) ?? [],
          ),
          spreads,
          editor_url: editorUrl(event_token),
        });
      } catch (layoutError) {
        return errorResult(layoutError);
      }
    },
  );

  server.registerTool(
    "lupa_duplicate_album",
    {
      title: "Duplicate Lupa album",
      description: "Creates a separate editable copy of an album (Lupa allows up to 3 copies per album).",
      inputSchema: { event_token: eventTokenSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ event_token }) => {
      try {
        const payload = await client.api<unknown>("duplicateAlbum", { event_token });
        return jsonResult({ duplicated: true, response: payload });
      } catch (duplicateError) {
        return errorResult(duplicateError);
      }
    },
  );

  server.registerTool(
    "lupa_delete_album",
    {
      title: "Delete Lupa album",
      description:
        "Permanently deletes an album and all its uploaded photos. Only call this after the user explicitly confirms " +
        "the album name to delete.",
      inputSchema: { event_token: eventTokenSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ event_token }) => {
      try {
        await client.api("deleteAlbum", { event_token });
        return jsonResult({ deleted: true, event_token });
      } catch (deleteError) {
        return errorResult(deleteError);
      }
    },
  );
}
