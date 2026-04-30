import { SessionState, type FeedSessionSnapshot, type FeedUser } from "@slashtalk/shared";

export interface CarouselHead {
  login: string;
  avatarUrl: string | null;
  live: boolean;
  lastTs: number;
  isSelf: boolean;
}

/** Sort heads with self pinned first (right of search), then teammates by most
 *  recent session activity descending. Heads with no activity sink to the end. */
export function buildCarouselHeads(
  selfLogin: string,
  selfAvatarUrl: string | null,
  users: FeedUser[],
  sessions: FeedSessionSnapshot[],
): CarouselHead[] {
  const lastTsByLogin = new Map<string, number>();
  const liveByLogin = new Map<string, boolean>();
  for (const s of sessions) {
    const ts = s.lastTs ? new Date(s.lastTs).getTime() : 0;
    const prior = lastTsByLogin.get(s.github_login) ?? 0;
    if (ts > prior) lastTsByLogin.set(s.github_login, ts);
    if (s.state === SessionState.BUSY || s.state === SessionState.ACTIVE) {
      liveByLogin.set(s.github_login, true);
    }
  }

  const known = new Map<string, CarouselHead>();
  for (const u of users) {
    known.set(u.github_login, {
      login: u.github_login,
      avatarUrl: u.avatar_url,
      live: liveByLogin.get(u.github_login) ?? false,
      lastTs: lastTsByLogin.get(u.github_login) ?? 0,
      isSelf: u.github_login === selfLogin,
    });
  }
  // Ensure self is always present even if /api/feed/users hasn't surfaced
  // them yet (fresh sign-in, no claimed repos, etc).
  if (!known.has(selfLogin)) {
    known.set(selfLogin, {
      login: selfLogin,
      avatarUrl: selfAvatarUrl,
      live: liveByLogin.get(selfLogin) ?? false,
      lastTs: lastTsByLogin.get(selfLogin) ?? 0,
      isSelf: true,
    });
  }

  const all = Array.from(known.values());
  const self = all.find((h) => h.isSelf);
  const peers = all.filter((h) => !h.isSelf).sort((a, b) => b.lastTs - a.lastTs);
  return self ? [self, ...peers] : peers;
}
