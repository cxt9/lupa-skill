import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { saveAuth } from "./auth.js";
import { API_URL, APP_VERSION, CLOUD_CODE, DEVICE_TYPE, WEB_EDITOR_ORIGIN } from "./config.js";

// Lupa has no OAuth or API keys. The web editor keeps its session token in
// localStorage["user-storage"]. To connect, the user logs in on the Lupa site as usual
// and runs a one-line snippet in that tab, which hands the token to this one-shot
// receiver on 127.0.0.1. The password never passes through this tool.

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface LoginSession {
  port: number;
  consoleSnippet: string;
  completion: Promise<void>;
  cancel: () => void;
}

let activeSession: LoginSession | null = null;

/** Checks the token against the API and returns the account's first name. */
export async function verifyToken(token: string): Promise<string | undefined> {
  const query = new URLSearchParams({
    method: "userAlbums",
    app_version: APP_VERSION,
    device_type: DEVICE_TYPE,
    cloudcode: CLOUD_CODE,
    isCustomErr: "false",
  });
  const response = await fetch(`${API_URL}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const envelope = (await response.json().catch(() => null)) as {
    isValid?: boolean;
    payload?: Array<{ host_name?: string }>;
  } | null;
  if (!response.ok || !envelope?.isValid) {
    throw new Error("Lupa did not accept this token. Make sure you are logged in on the Lupa site.");
  }
  return envelope.payload?.[0]?.host_name;
}

export function buildConsoleSnippet(port: number, nonce: string): string {
  return (
    `fetch("http://127.0.0.1:${port}/token",{method:"POST",headers:{"Content-Type":"text/plain"},` +
    `body:JSON.stringify({nonce:"${nonce}",token:JSON.parse(localStorage["user-storage"]).state.user.token})})` +
    `.then(r=>r.text()).then(console.log)`
  );
}

export function startLoginSession(): Promise<LoginSession> {
  if (activeSession) return Promise.resolve(activeSession);

  const nonce = randomBytes(16).toString("hex");
  let resolveCompletion!: () => void;
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Avoid unhandled rejections when nobody awaits the completion promise.
  completion.catch(() => {});

  const corsHeaders = {
    "Access-Control-Allow-Origin": WEB_EDITOR_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Content-Type": "text/plain; charset=utf-8",
  };

  const server: Server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/token") {
      response.writeHead(404, corsHeaders).end("Not found");
      return;
    }
    let requestBody = "";
    request.on("data", (chunk: Buffer) => {
      requestBody += chunk.toString("utf8");
      if (requestBody.length > 20_000) request.destroy();
    });
    request.on("end", async () => {
      try {
        const { nonce: receivedNonce, token } = JSON.parse(requestBody) as { nonce?: string; token?: string };
        if (receivedNonce !== nonce) {
          response.writeHead(403, corsHeaders).end("Wrong login session. Start the login again.");
          return;
        }
        if (!token) {
          response.writeHead(400, corsHeaders).end("No Lupa session found in this tab. Log in to Lupa first.");
          return;
        }
        const firstName = await verifyToken(token);
        await saveAuth(token);
        response
          .writeHead(200, corsHeaders)
          .end(`Lupa connected${firstName ? ` for ${firstName}` : ""}. You can close this tab and return to Claude.`);
        finish();
        resolveCompletion();
      } catch (loginError) {
        response.writeHead(400, corsHeaders).end((loginError as Error).message);
      }
    });
  });

  const timeout = setTimeout(() => {
    finish();
    rejectCompletion(new Error("Login timed out after 10 minutes."));
  }, LOGIN_TIMEOUT_MS);
  timeout.unref();

  function finish() {
    clearTimeout(timeout);
    server.close();
    activeSession = null;
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      activeSession = {
        port,
        consoleSnippet: buildConsoleSnippet(port, nonce),
        completion,
        cancel: () => {
          finish();
          rejectCompletion(new Error("Login cancelled."));
        },
      };
      resolve(activeSession);
    });
  });
}
