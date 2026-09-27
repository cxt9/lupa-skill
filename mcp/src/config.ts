// Endpoints and constants reverse-engineered from the Lupa web editor (online-v3.lupa.co.il).
// None of this is a documented or supported API: Lupa can change it at any time.

export const API_URL = "https://groupa.lupa.co.il/v1/api.aspx";
export const EDITOR_API_URL = "https://groupa.lupa.co.il/v1/editor.aspx";
export const UPLOAD_URL = "https://upload.lupa.co.il/api/BookImageUpload/upload-image";
export const WEB_EDITOR_ORIGIN = "https://online-v3.lupa.co.il";

// Sent by the web editor on every request; the server may use it for feature gating.
export const APP_VERSION = "3.5.27.tf";
export const DEVICE_TYPE = "desktop";
export const CLOUD_CODE = "public";

export const MIN_PHOTOS_PER_ALBUM = 24;
export const MAX_ALBUM_NAME_LENGTH = 28;

export const PROGRESS_COMPLETE_STATUSES = ["PDF_READY", "GENERATED"];
export const PROGRESS_ERROR_STATUSES = ["ERROR"];

// Refresh the session token proactively when it is older than this.
export const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

export const SUPPORTED_UPLOAD_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
export const CONVERTIBLE_EXTENSIONS = [".heic", ".heif"];

export function editorUrl(eventToken: string): string {
  return `${WEB_EDITOR_ORIGIN}/preview/${eventToken}`;
}

export function photoStackUrl(eventToken: string): string {
  return `${WEB_EDITOR_ORIGIN}/photo-stack/${eventToken}`;
}
