export interface MockPr {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: "merged" | "open" | "draft" | "closed";
  ts: string;
  authorLogin: string;
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const now = (): number => Date.now();

export const MOCK_PRS: MockPr[] = [
  {
    number: 132,
    title: "feat: live collision warnings when teammates edit the same file",
    repo: "herenotthere/slashtalk",
    url: "https://github.com/HereNotThere/slashtalk/pull/132",
    state: "merged",
    ts: new Date(now() - 4 * HOUR).toISOString(),
    authorLogin: "ryanpaulc1",
  },
  {
    number: 137,
    title: "chore: deprecate legacy heartbeat endpoint",
    repo: "herenotthere/slashtalk",
    url: "https://github.com/HereNotThere/slashtalk/pull/137",
    state: "open",
    ts: new Date(now() - 7 * HOUR).toISOString(),
    authorLogin: "ryanpaulc1",
  },
  {
    number: 135,
    title: "wip: redesign info window into a daily-standup view",
    repo: "herenotthere/slashtalk",
    url: "https://github.com/HereNotThere/slashtalk/pull/135",
    state: "draft",
    ts: new Date(now() - 30 * MIN).toISOString(),
    authorLogin: "ryanpaulc1",
  },
  {
    number: 128,
    title: "fix(server): bump integration.test.ts beforeAll timeout to 30s",
    repo: "herenotthere/slashtalk",
    url: "https://github.com/HereNotThere/slashtalk/pull/128",
    state: "merged",
    ts: new Date(now() - 22 * HOUR).toISOString(),
    authorLogin: "ryanpaulc1",
  },
];

export const MOCK_STANDUP =
  "Shipped live collision warnings (#132) — the rail and info window now flag when two people are editing the same file. Bumped a flaky integration-test timeout (#128). Drafted a redesign of this window into a daily-standup view (#135). Reviewed Erik's frosted chat-pill polish.";
