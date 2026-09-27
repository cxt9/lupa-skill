import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AUTH_FILE_PATH, clearAuth, loadAuth, saveAuth } from "./auth.js";
import { LupaClient } from "./client.js";
import { WEB_EDITOR_ORIGIN } from "./config.js";
import { startLoginSession, verifyToken } from "./login.js";
import { registerTools } from "./tools.js";

const SERVER_VERSION = "0.1.0";

async function runServer(): Promise<void> {
  const server = new McpServer(
    { name: "lupa", version: SERVER_VERSION },
    {
      instructions:
        "Tools for building printed photo books on Lupa (lupa.co.il), an Israeli photo book service, through its " +
        "unofficial web API. Typical flow: lupa_auth_status (lupa_login if needed) -> lupa_create_album -> " +
        "lupa_upload_photos -> lupa_get_book_options -> lupa_list_themes -> lupa_generate_book -> give the user the " +
        "editor_url. Ordering and payment always happen in the Lupa web editor, by the user.",
    },
  );
  registerTools(server, new LupaClient());
  await server.connect(new StdioServerTransport());
}

async function runLoginCommand(): Promise<void> {
  const session = await startLoginSession();
  console.log(`\nConnect your Lupa account:\n`);
  console.log(`  1. Open ${WEB_EDITOR_ORIGIN} and log in.`);
  console.log(`  2. Open the DevTools console on that tab (Mac: Cmd+Option+J) and paste:\n`);
  console.log(`${session.consoleSnippet}\n`);
  console.log(`  Or paste the token itself below and press Enter.\n`);

  const terminalInput = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const pastedToken = new Promise<void>((resolvePasted, rejectPasted) => {
    terminalInput.question("Token (optional): ", async (answer) => {
      const token = answer.trim();
      if (!token) return;
      try {
        await verifyToken(token);
        await saveAuth(token);
        resolvePasted();
      } catch (verifyError) {
        rejectPasted(verifyError);
      }
    });
  });

  try {
    await Promise.race([session.completion, pastedToken]);
    console.log(`\n\nConnected. Session saved to ${AUTH_FILE_PATH}`);
  } finally {
    session.cancel();
    terminalInput.close();
  }
}

async function runStatusCommand(): Promise<void> {
  const storedAuth = await loadAuth();
  if (!storedAuth) {
    console.log("Not logged in. Run: lupa-mcp login");
    process.exitCode = 1;
    return;
  }
  const client = new LupaClient();
  try {
    const firstName = await verifyToken(await client.getToken());
    console.log(`Logged in${firstName ? ` as ${firstName}` : ""}.`);
  } catch {
    const refreshed = await client.refreshToken();
    console.log(refreshed ? "Session refreshed and valid." : "Saved session expired. Run: lupa-mcp login");
    if (!refreshed) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "login":
      await runLoginCommand();
      process.exit(0);
      break;
    case "status":
      await runStatusCommand();
      break;
    case "logout":
      await clearAuth();
      console.log(`Removed ${AUTH_FILE_PATH}`);
      break;
    case undefined:
    case "serve":
      await runServer();
      break;
    default:
      console.error("Usage: lupa-mcp [serve|login|status|logout]");
      process.exitCode = 2;
  }
}

main().catch((fatalError) => {
  console.error(fatalError instanceof Error ? fatalError.message : fatalError);
  process.exit(1);
});
