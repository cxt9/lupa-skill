import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The session token lives only on the user's machine, never in the repository.
// Override the location with LUPA_AUTH_FILE, or skip the file entirely with LUPA_TOKEN.
export const AUTH_FILE_PATH =
  process.env.LUPA_AUTH_FILE ?? join(homedir(), ".config", "lupa-mcp", "auth.json");

export interface StoredAuth {
  token: string;
  savedAt: number;
  refreshedAt: number;
}

export async function loadAuth(): Promise<StoredAuth | null> {
  const environmentToken = process.env.LUPA_TOKEN?.trim();
  if (environmentToken) {
    return { token: environmentToken, savedAt: 0, refreshedAt: 0 };
  }
  try {
    const fileContents = await readFile(AUTH_FILE_PATH, "utf8");
    const parsedAuth = JSON.parse(fileContents) as StoredAuth;
    return parsedAuth.token ? parsedAuth : null;
  } catch {
    return null;
  }
}

export async function saveAuth(token: string, previous?: StoredAuth | null): Promise<void> {
  if (process.env.LUPA_TOKEN) {
    // The environment variable wins over the file; nothing to persist.
    return;
  }
  const now = Date.now();
  const authToStore: StoredAuth = {
    token,
    savedAt: previous?.savedAt || now,
    refreshedAt: now,
  };
  await mkdir(dirname(AUTH_FILE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE_PATH, JSON.stringify(authToStore, null, 2), { mode: 0o600 });
  await chmod(AUTH_FILE_PATH, 0o600);
}

export async function clearAuth(): Promise<void> {
  await rm(AUTH_FILE_PATH, { force: true });
}
