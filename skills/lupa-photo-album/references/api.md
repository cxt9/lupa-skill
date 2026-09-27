# Lupa web editor API (reverse-engineered)

Observed from the Lupa online editor (`online-v3.lupa.co.il`, app version `3.5.27.tf`) in September 2026. Not documented or supported by Lupa; it can change without notice.

## Hosts

| Purpose | URL |
|---|---|
| Main API | `https://groupa.lupa.co.il/v1/api.aspx?method=<name>` |
| Layout tree API | `https://groupa.lupa.co.il/v1/editor.aspx?action=editor&method=<name>` |
| Photo upload | `POST https://upload.lupa.co.il/api/BookImageUpload/upload-image` |
| Image URL signing | `POST https://signingservice.lupa.co.il/sign-images` |
| Cart / payment API | `https://paymentsv4-api.lupa.co.il/api.aspx?method=add_basket` |
| Checkout UI | `https://paymentsv4-ui.lupa.co.il/basketItems` |
| Login UI (iframe) | `https://connect-v2-ui.lupa.co.il/loginregister` |

The marketing site `www.lupa.co.il` is WordPress; its account dashboard uses a separate `account-v3.lupa.co.il/V2/api.aspx` (`get_dashboard`, `get_orders`, ...), not needed here.

## Auth

- Header `Authorization: Bearer <token>` on every call. No cookies.
- The editor stores the session in `localStorage["user-storage"]` as `{state: {user: {token, refreshtoken, firstName, lastName, email, isAuthenticated, ...}}}`.
- `method=refreshToken` (with the current Bearer token) returns a new token in `payload`. The editor refreshes periodically (`localStorage.lastTokenRefresh`).
- Missing or invalid token: HTTP 403, or envelope `Error: "ERROR_NO_TOKEN"`.

## Common query parameters

Every `api.aspx` call carries `app_version=3.5.27.tf&device_type=desktop&cloudcode=public&isCustomErr=false`. `editor.aspx` calls add `action=editor&lang=en&image_list=true&show_basket=false&show_friend_basket=false&event_token=...`.

## Response envelope

```json
{ "isValid": true, "errorCode": 0, "Error": null, "method": "userAlbums", "payload": ..., "errorDetails": null }
```

## Book creation flow (as the web wizard does it)

| Step | Call | Notes |
|---|---|---|
| Create | `GET updatealbum&album_name=..&event_type=REGULAR&flipbook_new=true&lang=he` | Payload is the album record incl. `event_token` (32 hex chars, the album id used everywhere). Rename = same method with `event_token` + `album_name` (+ `no_resp=true&tree_resp=true`). |
| Upload | `POST upload-image` multipart, field `file` + `EventToken`, `shouldCompress=true`, `shouldResize=true`, `ImageText`, `OriginatingDomain/DeviceType/Platform=desktop`, `Timestamp`, `DateTakenValue=""`, `TransactionId=""` | One file per request. Response `{success, response: {uniqueId, image_name, imageOriginalWidth, imageOriginalHeight, blurhash, ...}}`. |
| Options | `GET getbookformats&event_token=..&lang=en` | `formats[].covers[].densities[]`; see below. |
| Draft | `GET albumthemescategories&image_count=N&event_token=..&format=<cover id>&direction=RTL|LTR[&layout=layout_c]` | Returns theme catalogue (`designsNew`) **and builds the draft book** (`m_treeMessage`). Must precede `closealbum3`. `layout=layout_c` only for `magazine` density. |
| Generate | `POST closealbum3&event_token=..&lang=he&format=<cover id>&density=..&direction=RTL|LTR&album_theme=<theme id>&is_cover_edited=false&flipbook_new=true[&layout=layout_c]` | Empty urlencoded body. Album becomes `event_status=CLOSED`. |
| Poll | `GET albumprogress&event_token=..` | `ERROR_EVENT_SMARTBOOK_NOT_EXIST` for the first seconds, then `progress_status`: `GENERATING_PROCESS` ... `GENERATED` / `PDF_READY` (done) or `ERROR`. |
| Read layout | `GET editor.aspx ... method=gettreelayouts3` | Full "treeV5" JSON (about 80 KB for 30 photos). |
| Save layout | `POST editor.aspx ... method=updatetree3&force=false&isUpdateCover=false`, multipart `tree=<json>` [+ `delete_image_ids`] | Used by the editor after manual edits. Not used by this MCP server. |
| Order | `GET paymentsv4-api add_basket&event_token&format=<m_format>&cover_type=0&page_type=0|5&theme&pages&quantity&platform=web&source_type=books...`, then per-spread JPEG snapshots rendered in the browser uploaded to `UploadSnapshots.aspx`, then `uploadsnapshotscomplete2` | Browser-rendered; intentionally left to the user in the web editor. |

### Re-generating a generated book

A `CLOSED` album ignores `closealbum3` and rejects photo changes (`deleteImage` -> `ERROR_BOOK_ALREADY_CLOSED`). Call `reopenalbum&event_token=..` first: the album becomes `OPEN` and its layout is discarded (`gettreelayouts3` -> `ERROR_GETTING_SMARTBOOK`). Then run the Draft + Generate + Poll steps again.

### Other methods seen in the editor bundle

`userAlbums`, `albumsByEventToken&show_basket=true`, `deleteImage&image_name`, `deleteAlbum`, `duplicateAlbum` (payload = new event_token; max 3 copies), `reopenalbum`, `requesteditalbum`, `closealbumbookcovers`, `getPersonalInfo`, `getBasketCount`, `carousel`, `getepiprotextpage` / `saveepiprotextpage` / `deleteepiprotextpage` (prologue/epilogue text pages), `friendlist` / `friendinvite2` / ... (shared albums), `gethelp`, `risedata` (analytics), `savetheme`, `checkdate` (editor.aspx).

## Book options (September 2026)

| Format id | Size (cm) | Cover ids | Starting price |
|---|---|---|---|
| `square_big` | 30x30 | `square_large_normal` (hard), `square_large_layflat` | 184 / 248 NIS |
| `square` | 20x20 | `square_normal` (hard/soft), `square_layflat` | 129 / 179 NIS |
| `panoramic` | 30x22 | `panoramic_normal`, `panoramic_layflat` | 136 / 185 NIS |
| `classic` | 22x29 | `classic_normal`, `classic_layflat` | 145 / 186 NIS |

Densities per cover: `multiple` ("A visual delight", up to 6 per page), `magazine` ("Magazine style", `layout=layout_c`), `single` ("One on One"; layflat: "Feels like poster"). Photo limits: min 24; max 864 (normal) or 502 (layflat). `single` allows fewer (small square: 144 normal, 51 layflat). Always read the live limits from `getbookformats`.

Book types (`cover_families`): `regular` (solid colour themes: `white_new`, `beige_new`, `gray_new`, `black_new`, `blue_new`, `turquoise`, `light_pink_new`, `purple_new`, `green_new`, ...) and `coffee_table` a.k.a. lupart (illustrated: `travel_drawing_<place>`, `travel_lineart_*`, `travel_geo_*`, `travel_art_*`, `love_*`, `years_colors_<year>`, `family_illu_*`, `floral_*`, `num_bold_<n>`, ...; `magazine` density only).

## Layout tree (treeV5) essentials

```
m_treeV5
  m_album_name, m_album_theme, m_album_direction (RTL|LTR), m_format (format_index, e.g. 27),
  m_book_type (REGULAR), m_cover_type (HARD_COVER | LAYFLAT_COVER), m_cover_family, m_cover_theme
  m_book_subtree / m_cover_subtree
    m_spread_folders[]            SPREAD_TYPE / COVER_SPREAD_TYPE, m_size "w, h" px at 300 DPI
      m_child_folders[]           RIGHT_REGION_TYPE / LEFT_REGION_TYPE (a page), m_layoutID
        m_child_folders[]         IMAGE_TYPE slots (m_folderID)
    m_tree_tmages[]               {m_folderID -> slot, m_image_name, m_unique_id, m_crop_rect, ...}
    m_tree_texts                  text boxes
```

## Web editor routes

`/create` (name), `/photo-stack/<event_token>` (photos), `/wizard/<event_token>` (format, density, direction, book type, theme), `/preview/<event_token>` (editor and preview, add to cart).
