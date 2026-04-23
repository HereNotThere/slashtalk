import type { AuthConfig } from "./auth.ts";

export type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
};

export async function exchangeCode(config: AuthConfig, code: string): Promise<string> {
  // GitHub's OAuth token endpoint returns intermittent 503s for JSON bodies
  // from some clients; form-urlencoded is the documented happy path.
  const form = new URLSearchParams({
    client_id: config.githubClientId,
    client_secret: config.githubClientSecret,
    code,
  });
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "slashtalk-mcp",
    },
    body: form,
  });
  if (!res.ok) {
    const preview = await res.text().catch(() => "");
    throw new Error(
      `github token exchange ${res.status}: ${preview.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`github token exchange: ${body.error ?? "no token"}`);
  return body.access_token;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "slashtalk-mcp",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`github /user ${res.status}`);
  return (await res.json()) as GithubUser;
}
