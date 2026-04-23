// GitHub OAuth callback relay for the Chatheads desktop app's GitHub-MCP
// connection.
//
// GitHub OAuth Apps require a single fixed redirect_uri registered in the
// developer settings; we can't use a loopback URL with a dynamic Electron
// port. So our backend becomes the registered callback and relays the
// authorization code to the local Electron server.
//
// The state parameter from GitHub must be formatted as `<port>_<nonce>` —
// Electron chooses the port and nonce at start time, opens the browser to
// GitHub's authorize URL directly, and waits on 127.0.0.1:<port>/cb for us
// to redirect the code back.
//
// This endpoint is purely a relay: the Electron app holds the OAuth
// client_id/client_secret and does the token exchange itself. We never see
// or store tokens.

import { log } from "./server.ts";

export function handleGithubAppCallback(url: URL): Response {
  const state = url.searchParams.get("state");
  if (!state) return badRequest("missing state");

  const match = state.match(/^(\d+)_[A-Za-z0-9_-]+$/);
  if (!match) return badRequest("malformed state");

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return badRequest("invalid port");
  }

  const loopback = new URL(`http://127.0.0.1:${port}/cb`);
  const ghError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (ghError) {
    loopback.searchParams.set("error", ghError);
  } else if (!code) {
    loopback.searchParams.set("error", "missing_code");
  } else {
    loopback.searchParams.set("code", code);
    loopback.searchParams.set("state", state);
  }

  log("info", "github_app_relay", { port, hasCode: !!code });
  return Response.redirect(loopback.toString(), 302);
}

function badRequest(text: string): Response {
  return new Response(text, { status: 400 });
}
