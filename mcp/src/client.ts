import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { loadAuth, saveAuth, type StoredAuth } from "./auth.js";
import {
  API_URL,
  APP_VERSION,
  CLOUD_CODE,
  CONVERTIBLE_EXTENSIONS,
  DEVICE_TYPE,
  EDITOR_API_URL,
  SUPPORTED_UPLOAD_EXTENSIONS,
  TOKEN_REFRESH_INTERVAL_MS,
  UPLOAD_URL,
} from "./config.js";

const execFileAsync = promisify(execFile);

/** Every groupa.lupa.co.il response is wrapped in this envelope. */
export interface LupaEnvelope<PayloadType = unknown> {
  isValid: boolean;
  errorCode: number;
  Error: string | null;
  method: string;
  payload: PayloadType;
  errorDetails: unknown;
}

export class LupaError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number | string,
    public readonly isAuthError = false,
  ) {
    super(message);
    this.name = "LupaError";
  }
}

export class NotLoggedInError extends LupaError {
  constructor() {
    super(
      "Not logged in to Lupa. Run the lupa_login tool (or `npx lupa-mcp login` in a terminal) to connect your account.",
      "NOT_LOGGED_IN",
      true,
    );
  }
}

type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  method?: "GET" | "POST";
  body?: FormData | URLSearchParams;
}

function isAuthFailure(httpStatus: number, envelope?: Partial<LupaEnvelope>): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const errorName = envelope?.Error ?? "";
  return /TOKEN|UNAUTHORI|NOT_LOGGED|LOGIN/i.test(errorName);
}

function toQueryString(params: QueryParams): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return searchParams.toString();
}

export interface UploadedPhoto {
  file: string;
  imageName: string;
  uniqueId: number;
  width: number;
  height: number;
}

export interface UploadFailure {
  file: string;
  error: string;
}

export class LupaClient {
  private auth: StoredAuth | null = null;
  private refreshInFlight: Promise<boolean> | null = null;

  async getToken(): Promise<string> {
    if (!this.auth) this.auth = await loadAuth();
    if (!this.auth) throw new NotLoggedInError();
    const tokenAge = Date.now() - (this.auth.refreshedAt || 0);
    if (this.auth.refreshedAt && tokenAge > TOKEN_REFRESH_INTERVAL_MS) {
      await this.refreshToken();
    }
    return this.auth.token;
  }

  /** Drops the cached token so the next call re-reads it from disk (e.g. after login). */
  resetCachedAuth(): void {
    this.auth = null;
  }

  /** Exchanges the current token for a fresh one, the same way the web editor does. */
  async refreshToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const currentAuth = this.auth ?? (await loadAuth());
      if (!currentAuth) return false;
      try {
        const response = await fetch(
          `${API_URL}?${toQueryString(this.baseApiParams("refreshToken"))}`,
          { headers: { Authorization: `Bearer ${currentAuth.token}` } },
        );
        if (!response.ok) return false;
        const envelope = (await response.json()) as LupaEnvelope<string>;
        if (!envelope.isValid || typeof envelope.payload !== "string" || !envelope.payload) {
          return false;
        }
        await saveAuth(envelope.payload, currentAuth);
        this.auth = { ...currentAuth, token: envelope.payload, refreshedAt: Date.now() };
        return true;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private baseApiParams(method: string): QueryParams {
    return {
      method,
      app_version: APP_VERSION,
      device_type: DEVICE_TYPE,
      cloudcode: CLOUD_CODE,
      isCustomErr: "false",
    };
  }

  private baseEditorParams(method: string, eventToken: string): QueryParams {
    return {
      action: "editor",
      isCustomErr: "false",
      cloudcode: CLOUD_CODE,
      lang: "en",
      app_version: APP_VERSION,
      device_type: DEVICE_TYPE,
      image_list: "true",
      show_basket: "false",
      show_friend_basket: "false",
      event_token: eventToken,
      method,
    };
  }

  private async sendWithAuth<PayloadType>(
    buildUrl: () => string,
    options: RequestOptions,
    retryOnAuthFailure = true,
  ): Promise<LupaEnvelope<PayloadType>> {
    const token = await this.getToken();
    const response = await fetch(buildUrl(), {
      method: options.method ?? "GET",
      headers: { Authorization: `Bearer ${token}` },
      body: options.body,
    });

    let envelope: LupaEnvelope<PayloadType> | undefined;
    try {
      envelope = (await response.json()) as LupaEnvelope<PayloadType>;
    } catch {
      envelope = undefined;
    }

    if (isAuthFailure(response.status, envelope)) {
      if (retryOnAuthFailure && (await this.refreshToken())) {
        return this.sendWithAuth(buildUrl, options, false);
      }
      throw new LupaError(
        "Lupa rejected the saved session (it probably expired). Run lupa_login again to reconnect.",
        envelope?.Error ?? response.status,
        true,
      );
    }
    if (!response.ok || !envelope) {
      throw new LupaError(`Lupa request failed with HTTP ${response.status}`, response.status);
    }
    if (!envelope.isValid) {
      throw new LupaError(
        `Lupa returned ${envelope.Error ?? "an error"} (code ${envelope.errorCode}) for ${envelope.method}`,
        envelope.Error ?? envelope.errorCode,
      );
    }
    return envelope;
  }

  /** Calls groupa.lupa.co.il/v1/api.aspx?method=... */
  async api<PayloadType = unknown>(
    method: string,
    params: QueryParams = {},
    options: RequestOptions = {},
  ): Promise<PayloadType> {
    const envelope = await this.sendWithAuth<PayloadType>(
      () => `${API_URL}?${toQueryString({ ...this.baseApiParams(method), ...params })}`,
      options,
    );
    return envelope.payload;
  }

  /** Calls groupa.lupa.co.il/v1/editor.aspx?method=... (layout tree endpoints). */
  async editorApi<PayloadType = unknown>(
    method: string,
    eventToken: string,
    params: QueryParams = {},
    options: RequestOptions = {},
  ): Promise<PayloadType> {
    const envelope = await this.sendWithAuth<PayloadType>(
      () =>
        `${EDITOR_API_URL}?${toQueryString({ ...this.baseEditorParams(method, eventToken), ...params })}`,
      options,
    );
    return envelope.payload;
  }

  /** Uploads one photo into an album, exactly like the web editor's Uppy uploader. */
  async uploadPhoto(eventToken: string, filePath: string): Promise<UploadedPhoto> {
    const preparedFile = await prepareFileForUpload(filePath);
    try {
      const attemptUpload = async (retryOnAuthFailure: boolean): Promise<UploadedPhoto> => {
        const token = await this.getToken();
        const formData = new FormData();
        formData.set("shouldCompress", "true");
        formData.set("shouldResize", "true");
        formData.set("ImageText", "");
        formData.set("OriginatingDomain", DEVICE_TYPE);
        formData.set("DeviceType", DEVICE_TYPE);
        formData.set("Platform", DEVICE_TYPE);
        formData.set("Timestamp", new Date().toLocaleTimeString("en-US"));
        formData.set("DateTakenValue", "");
        formData.set("TransactionId", "");
        formData.set("EventToken", eventToken);
        const fileBlob = await openAsBlob(preparedFile.path, { type: preparedFile.mimeType });
        formData.set("file", fileBlob, preparedFile.uploadName);

        const response = await fetch(UPLOAD_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
          body: formData,
        });
        if ((response.status === 401 || response.status === 403) && retryOnAuthFailure) {
          if (await this.refreshToken()) return attemptUpload(false);
        }
        const responseBody = (await response.json().catch(() => null)) as {
          success?: boolean;
          errorCode?: number;
          errorMessage?: string | null;
          response?: {
            uniqueId: number;
            image_name: string;
            imageOriginalWidth: number;
            imageOriginalHeight: number;
          };
        } | null;
        if (!response.ok || !responseBody?.success || !responseBody.response) {
          throw new LupaError(
            `Upload failed (HTTP ${response.status}${
              responseBody?.errorMessage ? `: ${responseBody.errorMessage}` : ""
            })`,
            responseBody?.errorCode ?? response.status,
            response.status === 401 || response.status === 403,
          );
        }
        return {
          file: filePath,
          imageName: responseBody.response.image_name,
          uniqueId: responseBody.response.uniqueId,
          width: responseBody.response.imageOriginalWidth,
          height: responseBody.response.imageOriginalHeight,
        };
      };
      return await attemptUpload(true);
    } finally {
      await preparedFile.cleanup();
    }
  }

  async uploadPhotos(
    eventToken: string,
    filePaths: string[],
    concurrency: number,
  ): Promise<{ uploaded: UploadedPhoto[]; failed: UploadFailure[] }> {
    const uploaded: UploadedPhoto[] = [];
    const failed: UploadFailure[] = [];
    let nextFileIndex = 0;
    const runWorker = async () => {
      while (nextFileIndex < filePaths.length) {
        const filePath = filePaths[nextFileIndex++];
        try {
          uploaded.push(await this.uploadPhoto(eventToken, filePath));
        } catch (uploadError) {
          if (uploadError instanceof LupaError && uploadError.isAuthError) throw uploadError;
          failed.push({ file: filePath, error: (uploadError as Error).message });
        }
      }
    };
    const workerCount = Math.max(1, Math.min(concurrency, filePaths.length));
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    const originalOrder = new Map(filePaths.map((filePath, index) => [filePath, index]));
    uploaded.sort((first, second) => originalOrder.get(first.file)! - originalOrder.get(second.file)!);
    return { uploaded, failed };
  }
}

interface PreparedFile {
  path: string;
  uploadName: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** HEIC files are converted to JPEG with macOS `sips`, since the web editor also uploads JPEGs. */
async function prepareFileForUpload(filePath: string): Promise<PreparedFile> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) throw new LupaError(`Not a file: ${filePath}`);
  const extension = extname(filePath).toLowerCase();

  if (SUPPORTED_UPLOAD_EXTENSIONS.includes(extension)) {
    return {
      path: filePath,
      uploadName: basename(filePath),
      mimeType: MIME_TYPES_BY_EXTENSION[extension],
      cleanup: async () => {},
    };
  }

  if (CONVERTIBLE_EXTENSIONS.includes(extension)) {
    if (process.platform !== "darwin") {
      throw new LupaError(`HEIC conversion needs macOS (sips). Convert ${basename(filePath)} to JPEG first.`);
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "lupa-heic-"));
    const convertedName = `${basename(filePath, extname(filePath))}.jpg`;
    const convertedPath = join(temporaryDirectory, convertedName);
    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", filePath, "--out", convertedPath]);
    return {
      path: convertedPath,
      uploadName: convertedName,
      mimeType: "image/jpeg",
      cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
    };
  }

  throw new LupaError(`Unsupported file type ${extension || "(none)"}: ${basename(filePath)}`);
}
