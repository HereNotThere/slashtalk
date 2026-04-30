import type {
  ChatAskRequest,
  ChatAskResponse,
  FeedSessionSnapshot,
  FeedUser,
  ProjectOverviewResponse,
  SessionSnapshot,
  StandupResponse,
  UserPrsResponse,
} from "@slashtalk/shared";

export class AuthError extends Error {
  constructor() {
    super("signed out");
    this.name = "AuthError";
  }
}

export interface Me {
  id: number;
  githubLogin: string;
  avatarUrl: string | null;
  displayName: string | null;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchMe = () => apiFetch<Me>("/api/me/");
export const fetchFeedUsers = () => apiFetch<FeedUser[]>("/api/feed/users");
export const fetchFeed = () => apiFetch<FeedSessionSnapshot[]>("/api/feed");
export const fetchSession = (id: string) =>
  apiFetch<SessionSnapshot>(`/api/session/${encodeURIComponent(id)}`);

export const fetchUserPrs = (login: string, scope: "today" | "past24h" = "today") =>
  apiFetch<UserPrsResponse>(`/api/users/${encodeURIComponent(login)}/prs?scope=${scope}`);

export const fetchUserStandup = (login: string, scope: "today" | "past24h" = "today") =>
  apiFetch<StandupResponse>(`/api/users/${encodeURIComponent(login)}/standup?scope=${scope}`);

export const fetchRepoOverview = (fullName: string, scope: "today" | "past24h" = "today") => {
  const [owner, name] = fullName.split("/");
  return apiFetch<ProjectOverviewResponse>(
    `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/overview?scope=${scope}`,
  );
};

export const askChat = (body: ChatAskRequest) =>
  apiFetch<ChatAskResponse>("/api/chat/ask", { method: "POST", body: JSON.stringify(body) });

export const fetchGerunds = (prompt: string) =>
  apiFetch<{ words: string[] }>("/api/chat/gerund", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
