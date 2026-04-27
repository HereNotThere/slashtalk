/**
 * Wraps `fetch` against api.github.com with the error-categorization the
 * three repo-claim verification paths share: try/catch the network call,
 * categorize HTTP status into a small set of reasons, and emit a uniform
 * warn log. Callers map `reason` to their own domain (e.g. `VerifyOutcome`).
 */
export type GithubFetchOutcome =
  | { ok: true; res: Response }
  | { ok: false; status: number | null; reason: GithubFetchFailure };

type GithubFetchFailure =
  | "network_error" // fetch threw (timeout, DNS, etc.)
  | "not_found" // 404
  | "unauthorized" // 401
  | "forbidden" // 403
  | "upstream_other"; // any other non-2xx

const STATUS_REASONS: Record<number, GithubFetchFailure> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
};

export async function githubFetch(
  url: string,
  init: RequestInit,
  logTag: string,
): Promise<GithubFetchOutcome> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.warn(`[${logTag}] fetch threw:`, (err as Error).message);
    return { ok: false, status: null, reason: "network_error" };
  }

  if (res.ok) return { ok: true, res };

  const reason = STATUS_REASONS[res.status] ?? "upstream_other";
  console.warn(`[${logTag}] GitHub ${res.status} (${reason})`);
  return { ok: false, status: res.status, reason };
}
