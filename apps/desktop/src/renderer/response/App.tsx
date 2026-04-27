import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ClockIcon, PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatThread,
  SessionCard,
  SessionState,
} from "@slashtalk/shared";
import type { AgentSummary, ChatHead, ResponseOpenPayload } from "../../shared/types";
import { AgentChat } from "../info/AgentPanel";
import { Button } from "../shared/Button";
import { CheckIcon, CopyIcon } from "../shared/icons";

const CITATION_TOKEN = /\[session:[0-9a-fA-F-]+\]/g;
const CARDS_VISIBLE = 5;
const COPIED_FEEDBACK_MS = 1500;

function buildMarkdownForAssistantMessage(m: ChatAssistantMessage): string {
  const body = m.content.replace(CITATION_TOKEN, "").trim();
  if (!m.cards || m.cards.length === 0) return body;

  const lines = [
    "> The following coding sessions were referenced when generating this answer:",
    ...m.cards.map((c) => {
      const title = c.title ?? "Untitled session";
      const author = c.user.displayName ?? c.user.login;
      const bits = [
        c.repo ? `repo \`${c.repo}\`` : null,
        c.branch ? `branch \`${c.branch}\`` : null,
        author ? `by ${author}` : null,
      ].filter((bit): bit is string => bit !== null);
      return `> - **${title}**${bits.length ? ` — ${bits.join(", ")}` : ""}`;
    }),
    "",
  ];
  return `${lines.join("\n")}\n${body}`;
}

function SlashtalkSpinner(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="slashtalk-spinner shrink-0"
      aria-hidden
    >
      <rect width="48" height="48" rx="12" fill="url(#slashtalk-spinner-grad)" />
      <circle className="dot-1" cx="13" cy="11" r="5" fill="white" />
      <circle className="dot-2" cx="13" cy="24" r="5" fill="white" />
      <circle className="dot-3" cx="13" cy="37" r="5" fill="white" />
      <defs>
        <linearGradient
          id="slashtalk-spinner-grad"
          x1="24"
          y1="0"
          x2="24"
          y2="48"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#2ECF81" />
          <stop offset="1" stopColor="#0BB764" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const DEFAULT_GERUNDS = ["Thinking"];
const GERUND_CYCLE_MS = 2200;

const MARKDOWN_CLASSES =
  "break-words text-fg text-md leading-relaxed " +
  "[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_ul]:my-3 [&_ol]:my-3 [&_ul]:pl-5 [&_ol]:pl-5 [&_ul]:list-disc [&_ol]:list-decimal " +
  "[&_li]:my-1 [&_li]:pl-1 " +
  "[&_code]:px-[0.35em] [&_code]:py-[0.15em] [&_code]:rounded-md [&_code]:bg-code " +
  "[&_code]:font-mono [&_code]:text-[0.88em] [&_code]:font-medium " +
  "[&_pre]:bg-code [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-auto [&_pre]:my-4 " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-normal " +
  "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:tracking-tight " +
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:tracking-tight " +
  "[&_h3]:text-md [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 " +
  "[&_strong]:font-semibold [&_strong]:text-fg " +
  "[&_em]:italic " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-divider [&_blockquote]:pl-4 [&_blockquote]:text-muted [&_blockquote]:my-3 " +
  "[&_hr]:border-divider [&_hr]:my-6 " +
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-primary-hover";

export function App(): JSX.Element {
  const [payload, setPayload] = useState<ResponseOpenPayload | null>(null);

  useEffect(() => {
    return window.chatheads.onResponseOpen((next) => {
      setPayload(next);
    });
  }, []);

  if (payload?.kind === "agent") {
    return <AgentResponse payload={payload} />;
  }

  return <MessageResponse seed={payload ?? null} />;
}

type MessageSeed =
  | { kind: "message"; message: string }
  | { kind: "thread"; thread: ChatThread }
  | null;

function rehydrateMessagesFromThread(thread: ChatThread): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const turn of thread.turns) {
    out.push({ role: "user", content: turn.prompt });
    out.push({
      role: "assistant",
      content: turn.answer,
      citations: turn.citations,
      // Attach cards only on the final assistant turn — they're aggregated
      // across the whole thread, so duplicating per-turn would double-render.
      cards: undefined,
    });
  }
  if (out.length > 0 && thread.cards.length > 0) {
    const last = out[out.length - 1];
    if (last.role === "assistant") last.cards = thread.cards;
  }
  return out;
}

function AgentResponse({
  payload,
}: {
  payload: Extract<ResponseOpenPayload, { kind: "agent" }>;
}): JSX.Element {
  const [agent, setAgent] = useState<AgentSummary | null>(null);

  useEffect(() => {
    let cancelled = false;

    const updateAgent = (agents: AgentSummary[]): void => {
      if (!cancelled) {
        setAgent(agents.find((item) => item.id === payload.agentId) ?? null);
      }
    };

    void window.chatheads.agents.list().then(updateAgent);
    const unsubscribe = window.chatheads.agents.onListChange(updateAgent);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [payload.agentId]);

  const head: ChatHead = {
    id: `agent:${payload.agentId}`,
    label: agent?.name ?? "Agent",
    tint: "#86a5ff",
    avatar: { type: "emoji", value: agent?.name?.[0] ?? "A" },
    kind: "agent",
  };

  return (
    <div className="h-screen bg-bg text-fg">
      <AgentChat
        key={`${payload.agentId}:${payload.sessionId}`}
        head={head}
        agent={agent}
        agentId={payload.agentId}
        sessionId={payload.sessionId}
        seed={null}
        fullHeight
        onBack={() => window.close()}
        onClose={() => window.close()}
      />
    </div>
  );
}

function MessageResponse({ seed }: { seed: MessageSeed }): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [followUp, setFollowUp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gerunds, setGerunds] = useState<string[]>(DEFAULT_GERUNDS);
  const [gerundIdx, setGerundIdx] = useState(0);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleCopyAssistantMessage(m: ChatAssistantMessage, idx: number): Promise<void> {
    try {
      await window.chatheads.copyText(buildMarkdownForAssistantMessage(m));
      setCopiedIdx(idx);
      setTimeout(() => {
        setCopiedIdx((current) => (current === idx ? null : current));
      }, COPIED_FEEDBACK_MS);
    } catch {
      /* swallow */
    }
  }

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    if (!loading || gerunds.length <= 1) return;
    const id = setInterval(() => {
      setGerundIdx((i) => (i + 1) % gerunds.length);
    }, GERUND_CYCLE_MS);
    return () => clearInterval(id);
  }, [loading, gerunds]);

  useEffect(() => {
    if (!seed) return;
    setError(null);
    setFollowUp("");
    setHistoryOpen(false);
    if (seed.kind === "message") {
      const initial: ChatMessage[] = [{ role: "user", content: seed.message }];
      setMessages(initial);
      setThreadId(undefined);
      void ask(initial, seed.message, undefined);
    } else {
      // Reopen a saved thread — rehydrate without re-asking.
      setMessages(rehydrateMessagesFromThread(seed.thread));
      setThreadId(seed.thread.threadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function ask(
    history: ChatMessage[],
    prompt: string,
    currentThreadId: string | undefined,
  ): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    setGerunds(DEFAULT_GERUNDS);
    setGerundIdx(0);
    const gerundPromise = window.chatheads
      .fetchChatGerunds(prompt)
      .then((words) => {
        if (words && words.length > 0) {
          setGerunds(words);
          setGerundIdx(0);
        }
      })
      .catch(() => {});
    try {
      const res = await window.chatheads.askChat(history, currentThreadId);
      setMessages((prev) => [...prev, res.message]);
      setThreadId(res.threadId);
    } catch (err) {
      setError((err as Error).message || "Something went wrong");
    } finally {
      void gerundPromise;
      setLoading(false);
    }
  }

  function handleFollowUpSend(): void {
    const trimmed = followUp.trim();
    if (!trimmed || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setFollowUp("");
    void ask(next, trimmed, threadId);
  }

  function loadThread(thread: ChatThread): void {
    setMessages(rehydrateMessagesFromThread(thread));
    setThreadId(thread.threadId);
    setError(null);
    setHistoryOpen(false);
  }

  return (
    <div className="flex flex-col h-screen bg-bg relative">
      <div className="flex-none flex items-center justify-end px-3 py-2 border-b border-divider">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-label={historyOpen ? "Close history" : "Open history"}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-subtle hover:text-fg hover:bg-surface-alt-hover transition-colors"
        >
          <ClockIcon className="w-4 h-4" />
          <span>History</span>
        </button>
      </div>
      {historyOpen && (
        <HistoryDrawer
          activeThreadId={threadId}
          onPick={loadThread}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 py-8 space-y-7">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="px-4 py-3 rounded-2xl max-w-[85%] bg-surface-alt text-fg text-md leading-snug whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="group space-y-3">
                <div className={MARKDOWN_CLASSES}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {m.content.replace(CITATION_TOKEN, "")}
                  </ReactMarkdown>
                </div>
                {m.cards && m.cards.length > 0 && <SessionCardStack cards={m.cards} />}
                <CopyMessageButton
                  copied={copiedIdx === i}
                  onCopy={() => void handleCopyAssistantMessage(m, i)}
                />
              </div>
            ),
          )}

          {loading && (
            <div className="flex items-center gap-2.5 text-base">
              <SlashtalkSpinner />
              <span className="shimmer-text italic">{gerunds[gerundIdx] ?? gerunds[0]}...</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-danger bg-danger/10 px-3 py-2 rounded-md">{error}</div>
          )}
        </div>
      </div>

      <div className="flex-none">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-6 pt-2">
          <div className="flex items-center gap-2 p-2 pl-5 rounded-full bg-surface border border-divider focus-within:border-subtle transition-colors">
            <input
              ref={inputRef}
              autoFocus
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleFollowUpSend();
                }
              }}
              placeholder={loading ? "Waiting for reply..." : "Reply to Slashtalk..."}
              disabled={loading}
              className="flex-1 min-w-0 bg-transparent border-none outline-none py-2 text-fg text-md leading-snug placeholder:text-subtle disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="md"
              round
              onClick={handleFollowUpSend}
              disabled={loading || !followUp.trim()}
              aria-label="Send"
              icon={<PaperAirplaneIcon className="w-4 h-4" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyMessageButton({
  copied,
  onCopy,
}: {
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied to clipboard" : "Copy response as markdown"}
      className="
        inline-flex items-center gap-1.5
        px-2 py-1 -ml-2
        rounded-md
        text-xs text-subtle hover:text-fg
        hover:bg-surface-alt-hover
        opacity-0 group-hover:opacity-100 focus-visible:opacity-100
        transition-opacity
      "
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function SessionCardStack({ cards }: { cards: SessionCard[] }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const overflow = Math.max(0, cards.length - CARDS_VISIBLE);
  const visible = expanded ? cards : cards.slice(0, CARDS_VISIBLE);

  return (
    <div className="space-y-2">
      {visible.map((c) => (
        <SessionCardView key={c.id} card={c} />
      ))}
      {overflow > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-subtle hover:text-muted underline decoration-dotted underline-offset-2"
        >
          + {overflow} more
        </button>
      )}
    </div>
  );
}

function SessionCardView({ card }: { card: SessionCard }): JSX.Element {
  const name = card.user.displayName ?? card.user.login;
  const primary = card.title ?? card.lastUserPrompt ?? "(no title)";
  const meta = [
    `@${card.user.login}`,
    card.repo,
    card.branch,
    card.lastTs ? relativeTime(card.lastTs) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const tool = card.currentTool ? `running ${card.currentTool}` : null;

  return (
    <button
      type="button"
      onClick={() =>
        void window.chatheads.openSessionCard({
          sessionId: card.id,
          login: card.user.login,
        })
      }
      aria-label={`Open session details for @${card.user.login}`}
      className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl bg-surface-alt hover:bg-surface-alt-hover text-left transition-colors"
    >
      <Avatar src={card.user.avatarUrl} fallback={name} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-medium text-fg truncate">{primary}</span>
          <StateDot state={card.state} />
        </div>
        <div className="text-xs text-subtle truncate">{meta}</div>
        {tool && <div className="text-xs text-muted/70 truncate">{tool}</div>}
      </div>
    </button>
  );
}

function Avatar({ src, fallback }: { src: string | null; fallback: string }): JSX.Element {
  if (src) {
    return (
      <img src={src} alt="" className="w-8 h-8 rounded-full shrink-0 bg-surface-alt object-cover" />
    );
  }
  return (
    <div className="w-8 h-8 rounded-full shrink-0 bg-surface-alt flex items-center justify-center text-xs text-muted">
      {fallback.slice(0, 1).toUpperCase()}
    </div>
  );
}

const STATE_DOT: Record<SessionState, { color: string; pulse: boolean }> = {
  busy: { color: "bg-warning", pulse: true },
  active: { color: "bg-success", pulse: true },
  idle: { color: "bg-info", pulse: false },
  recent: { color: "bg-subtle", pulse: false },
  ended: { color: "bg-border", pulse: false },
};

function StateDot({ state }: { state: SessionState }): JSX.Element {
  const { color, pulse } = STATE_DOT[state];
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${color} ${pulse ? "animate-pulse" : ""}`}
      title={state}
    />
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function HistoryDrawer({
  activeThreadId,
  onPick,
  onClose,
}: {
  activeThreadId: string | undefined;
  onPick: (thread: ChatThread) => void;
  onClose: () => void;
}): JSX.Element {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.chatheads
      .fetchChatHistory()
      .then((res) => {
        if (!cancelled) setThreads(res.threads);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message ?? "Failed to load history");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="absolute inset-x-0 top-[37px] bottom-0 z-10 bg-bg border-t border-divider flex flex-col">
      <div className="flex-none flex items-center justify-between px-4 py-2 border-b border-divider">
        <span className="text-sm font-medium text-fg">Recent questions</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          className="p-1 rounded-md text-subtle hover:text-fg hover:bg-surface-alt-hover transition-colors"
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-2 py-2">
        {threads === null && !error && (
          <div className="px-3 py-2 text-xs text-subtle">Loading…</div>
        )}
        {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
        {threads && threads.length === 0 && (
          <div className="px-3 py-2 text-xs text-subtle">
            No questions yet. Anything you ask shows up here.
          </div>
        )}
        {threads?.map((t) => {
          const isActive = t.threadId === activeThreadId;
          const turnCount = t.turns.length;
          return (
            <button
              key={t.threadId}
              type="button"
              onClick={() => onPick(t)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                isActive ? "bg-surface-alt" : "hover:bg-surface-alt-hover"
              }`}
            >
              <div className="text-sm text-fg line-clamp-2">{t.title}</div>
              <div className="text-xs text-subtle mt-0.5">
                {relativeTime(t.updatedAt)}
                {turnCount > 1 ? ` · ${turnCount} turns` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
