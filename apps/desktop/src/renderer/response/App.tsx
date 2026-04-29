import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_LINK_COMPONENT } from "../shared/MarkdownLink";
import {
  Bars3Icon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatThread,
  SessionCard,
  SessionState,
} from "@slashtalk/shared";
import type {
  AgentSummary,
  ChatDelegateEvent,
  ChatHead,
  DelegatedChatRequest,
  DelegatedChatResponse,
  ResponseOpenPayload,
  TrackedRepo,
} from "../../shared/types";
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

function describeDelegateEvent(e: ChatDelegateEvent): string | null {
  if (e.kind === "tool_use") {
    if (e.name === "Bash" && e.input && typeof e.input === "object") {
      const cmd = (e.input as { command?: unknown }).command;
      if (typeof cmd === "string" && cmd) {
        return `Running \`${cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}\``;
      }
    }
    if (
      (e.name === "Read" || e.name === "Grep" || e.name === "Glob") &&
      e.input &&
      typeof e.input === "object"
    ) {
      const target =
        (e.input as { file_path?: unknown }).file_path ??
        (e.input as { pattern?: unknown }).pattern ??
        (e.input as { path?: unknown }).path;
      if (typeof target === "string" && target) {
        return `${e.name} ${target.length > 60 ? "…" + target.slice(-57) : target}`;
      }
    }
    return `Running ${e.name}`;
  }
  if (e.kind === "phase" && e.label) return e.label;
  if (e.kind === "thinking") return "Thinking…";
  if (e.kind === "error") return `Error: ${e.message}`;
  return null;
}

const SAMPLE_PROMPTS = [
  "What did the team ship this week?",
  "Summarize the open PRs across our repos",
  "What's blocking the team right now?",
  "Roast my team based on their PRs",
];

const MARKDOWN_CLASSES =
  "break-words text-fg text-base leading-relaxed " +
  "[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_ul]:my-3 [&_ol]:my-3 [&_ul]:pl-5 [&_ol]:pl-5 [&_ul]:list-disc [&_ol]:list-decimal " +
  "[&_li]:my-1 [&_li]:pl-1 " +
  "[&_code]:px-[0.35em] [&_code]:py-[0.15em] [&_code]:rounded-md [&_code]:bg-code " +
  "[&_code]:font-mono [&_code]:text-[0.88em] [&_code]:font-medium " +
  "[&_pre]:bg-code [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-auto [&_pre]:my-4 " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-normal " +
  "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:tracking-tight " +
  "[&_h2]:text-md [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:tracking-tight " +
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 " +
  "[&_strong]:font-semibold [&_strong]:text-fg " +
  "[&_em]:italic " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-divider [&_blockquote]:pl-4 [&_blockquote]:text-muted [&_blockquote]:my-3 " +
  "[&_hr]:border-divider [&_hr]:my-6 " +
  "[&_table]:w-full [&_table]:my-4 [&_table]:border-collapse [&_table]:text-sm " +
  "[&_thead]:border-b [&_thead]:border-divider " +
  "[&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:align-top " +
  "[&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:border-t [&_td]:border-divider/60 " +
  "[&_tbody_tr:first-child_td]:border-t-0 " +
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
  // At most one delegated run is active per Ask window. Tracked by the
  // server-side messageId of the placeholder we'll mutate on completion —
  // safer than an array index, which goes stale on history-jump or new-chat.
  const [delegateRun, setDelegateRun] = useState<{
    messageId: string;
    statusLine: string;
  } | null>(null);
  const [repoPicker, setRepoPicker] = useState<{
    candidates: TrackedRepo[];
    pendingReq: DelegatedChatRequest;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic token used to ignore stale ask() resolutions. Bumped whenever
  // the conversation context changes underneath an in-flight request — the
  // seed effect (new payload from main) and loadThread (user picked a saved
  // thread from history). Without this, a user picking a thread while a
  // response is loading would see the in-flight answer appended to the new
  // thread and the new thread's id overwritten by the abandoned one.
  const askTokenRef = useRef(0);

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
    // Invalidate any in-flight ask from the previous seed so its eventual
    // response doesn't clobber the new conversation.
    askTokenRef.current++;
    setError(null);
    setFollowUp("");
    setHistoryOpen(false);
    setLoading(false);
    setDelegateRun(null);
    setRepoPicker(null);
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
    // `ask` is a non-memoized closure over local state; including it would
    // re-fire this effect on every render. Concurrency is governed by
    // askTokenRef, not the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  // The trace isn't persisted (server stores the final answer only), so this
  // subscription stays renderer-local.
  useEffect(() => {
    return window.chatheads.onDelegatedEvent((event) => {
      setDelegateRun((prev) => {
        if (!prev) return prev;
        const next = describeDelegateEvent(event);
        if (next === null || next === prev.statusLine) return prev;
        return { ...prev, statusLine: next };
      });
    });
  }, []);

  async function runDelegated(req: DelegatedChatRequest): Promise<void> {
    // Same staleness contract as ask(): if the user switches threads or
    // starts a new chat mid-run, drop the result silently. The placeholder
    // row is already persisted server-side, so the answer isn't lost — it
    // just doesn't pollute the new conversation.
    const myToken = askTokenRef.current;
    setDelegateRun({ messageId: req.messageId, statusLine: "Investigating…" });
    let res: DelegatedChatResponse;
    try {
      res = await window.chatheads.runDelegatedChat(req);
    } catch (err) {
      // Catch needed because delegateRun is what gates `inputBusy` — an
      // unhandled rejection would leave the input permanently locked.
      setDelegateRun((prev) => (prev?.messageId === req.messageId ? null : prev));
      if (askTokenRef.current === myToken) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Delegated chat failed");
      }
      return;
    }
    if (askTokenRef.current !== myToken) {
      // Drop the spinner if it's still tied to this run. Match by messageId
      // so we don't clobber a newer delegation that happens to have started
      // while we were awaiting (it would have overwritten delegateRun).
      setDelegateRun((prev) => (prev?.messageId === req.messageId ? null : prev));
      return;
    }
    if (res.kind === "needs-repo") {
      setDelegateRun(null);
      setRepoPicker({ candidates: res.candidates, pendingReq: req });
      return;
    }
    setDelegateRun(null);
    if (res.kind === "error") {
      setError(res.message);
      return;
    }
    if (!res.text) {
      setError("Local agent returned an empty answer.");
      return;
    }
    const footerParts: string[] = [];
    if (req.repoFullName) footerParts.push(`ran locally on \`${req.repoFullName}\``);
    if (!res.ghAvailable) {
      footerParts.push(
        "PR/CI data is from local git only — `gh auth login` would give live answers",
      );
    }
    if (res.hadError)
      footerParts.push("the agent hit an error mid-run; this answer may be partial");
    const footer = footerParts.length > 0 ? `\n\n_${footerParts.join(" — ")}_` : "";
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "assistant" && m.delegation?.messageId === req.messageId
          ? { ...m, content: res.text + footer, delegation: undefined }
          : m,
      ),
    );
  }

  function handleRepoPick(repoId: number): void {
    if (!repoPicker) return;
    const { pendingReq } = repoPicker;
    setRepoPicker(null);
    void runDelegated({ ...pendingReq, resolvedRepoId: repoId });
  }

  async function ask(
    history: ChatMessage[],
    prompt: string,
    currentThreadId: string | undefined,
  ): Promise<void> {
    // No closed-over `loading` guard: that reads the render-time value and
    // would swallow a fresh ask kicked off by the seed effect after a
    // synchronous setLoading(false) (the new `loading` value isn't visible
    // to this closure until the next render). Concurrency is governed by
    // askTokenRef — any earlier in-flight ask's resolution sees a mismatched
    // token and drops its writes. User-driven double-submit is prevented at
    // the call sites: handleFollowUpSend's own loading guard and the input's
    // disabled={loading} attribute.
    const myToken = ++askTokenRef.current;
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
      // The conversation context may have changed mid-flight (user picked
      // a thread from history, or a new seed arrived). Drop the answer if
      // so — it was still persisted server-side, so the user can find it
      // in their history list later.
      if (askTokenRef.current !== myToken) return;
      setMessages((prev) => [...prev, res.message]);
      setThreadId(res.threadId);
      if (res.message.delegation) {
        void runDelegated({
          task: res.message.delegation.task,
          repoFullName: res.message.delegation.repoFullName,
          threadId: res.threadId,
          messageId: res.message.delegation.messageId,
        });
      }
    } catch (err) {
      if (askTokenRef.current !== myToken) return;
      setError((err as Error).message || "Something went wrong");
    } finally {
      void gerundPromise;
      if (askTokenRef.current === myToken) setLoading(false);
    }
  }

  // Treated as "busy" for input gating. `loading` covers ask() in-flight,
  // but a delegation that's already returned to the renderer (delegateRun)
  // or stalled waiting for a repo pick (repoPicker) leaves loading=false
  // while a follow-up would still bump askTokenRef and either strand the
  // placeholder ("Looking deeper…") or fork two delegations atop one stale
  // repo picker.
  const inputBusy = loading || delegateRun !== null || repoPicker !== null;

  function handleFollowUpSend(): void {
    const trimmed = followUp.trim();
    if (!trimmed || inputBusy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setFollowUp("");
    void ask(next, trimmed, threadId);
  }

  function handleSamplePrompt(prompt: string): void {
    if (loading) return;
    const initial: ChatMessage[] = [{ role: "user", content: prompt }];
    setMessages(initial);
    setThreadId(undefined);
    setError(null);
    setFollowUp("");
    void ask(initial, prompt, undefined);
  }

  function loadThread(thread: ChatThread): void {
    // Invalidate any in-flight ask before swapping context — see askTokenRef.
    askTokenRef.current++;
    setMessages(rehydrateMessagesFromThread(thread));
    setThreadId(thread.threadId);
    setError(null);
    setLoading(false);
    setHistoryOpen(false);
    setDelegateRun(null);
    setRepoPicker(null);
  }

  function startNewChat(): void {
    askTokenRef.current++;
    setMessages([]);
    setThreadId(undefined);
    setError(null);
    setFollowUp("");
    setLoading(false);
    setHistoryOpen(false);
    setDelegateRun(null);
    setRepoPicker(null);
  }

  return (
    <div className="flex flex-col h-screen bg-surface-2 relative overflow-hidden">
      <div className="flex-none flex items-center justify-center px-3 py-2 border-b border-divider bg-surface-2 relative z-30">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-label={historyOpen ? "Close menu" : "Open menu"}
          className="absolute left-3 inline-flex items-center justify-center p-1.5 rounded-md text-subtle hover:text-fg hover:bg-surface-alt-hover transition-colors"
        >
          {historyOpen ? <XMarkIcon className="w-5 h-5" /> : <Bars3Icon className="w-5 h-5" />}
        </button>
        <span className="text-sm text-muted truncate">Ask anything about your team</span>
      </div>
      <HistorySideNav
        open={historyOpen}
        activeThreadId={threadId}
        onPick={loadThread}
        onNewChat={startNewChat}
        onClose={() => setHistoryOpen(false)}
      />
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 py-8 space-y-7">
          {messages.length === 0 && !loading && !error && (
            <SamplePrompts onPick={handleSamplePrompt} />
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="px-4 py-3 rounded-2xl max-w-[85%] bg-surface-alt text-fg text-base leading-snug whitespace-pre-wrap break-words">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="group space-y-3">
                <div className={MARKDOWN_CLASSES}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_COMPONENT}>
                    {m.content.replace(CITATION_TOKEN, "")}
                  </ReactMarkdown>
                </div>
                {delegateRun?.messageId === m.delegation?.messageId && delegateRun && (
                  <div className="flex items-center gap-2 text-sm text-subtle">
                    <SlashtalkSpinner />
                    <span className="shimmer-text italic">{delegateRun.statusLine}</span>
                  </div>
                )}
                {repoPicker?.pendingReq.messageId === m.delegation?.messageId && repoPicker && (
                  <RepoPicker
                    candidates={repoPicker.candidates}
                    onPick={handleRepoPick}
                    onCancel={() => setRepoPicker(null)}
                  />
                )}
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
              placeholder={inputBusy ? "Waiting for reply..." : "Ask anything"}
              disabled={inputBusy}
              className="flex-1 min-w-0 bg-transparent border-none outline-none py-2 text-fg text-base leading-snug placeholder:text-subtle disabled:opacity-60"
            />
            <Button
              variant="primary"
              size="md"
              round
              onClick={handleFollowUpSend}
              disabled={inputBusy || !followUp.trim()}
              aria-label="Send"
              icon={<PaperAirplaneIcon className="w-4 h-4" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SamplePrompts({ onPick }: { onPick: (prompt: string) => void }): JSX.Element {
  return (
    <div className="space-y-3 pt-4">
      <div className="text-sm text-subtle">Try asking:</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {SAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="text-left px-4 py-3 rounded-xl bg-surface-alt hover:bg-surface-alt-hover text-fg text-sm leading-snug transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function RepoPicker({
  candidates,
  onPick,
  onCancel,
}: {
  candidates: TrackedRepo[];
  onPick: (repoId: number) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-divider bg-surface-alt px-4 py-3 space-y-2">
      <div className="text-sm text-subtle">Which repo should I look in?</div>
      <div className="flex flex-wrap gap-2">
        {candidates.map((r) => (
          <button
            key={r.repoId}
            type="button"
            onClick={() => onPick(r.repoId)}
            className="px-3 py-1.5 rounded-full bg-surface text-fg text-sm hover:bg-surface-alt-hover border border-divider transition-colors"
          >
            {r.fullName}
          </button>
        ))}
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-full text-subtle text-sm hover:text-fg transition-colors"
        >
          Cancel
        </button>
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

function HistorySideNav({
  open,
  activeThreadId,
  onPick,
  onNewChat,
  onClose,
}: {
  open: boolean;
  activeThreadId: string | undefined;
  onPick: (thread: ChatThread) => void;
  onNewChat: () => void;
  onClose: () => void;
}): JSX.Element {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset before each refetch — the component is now always mounted, so
    // state from a prior open lingers. Without this, a previous error +
    // a subsequent successful fetch would render both at once.
    setError(null);
    setThreads(null);
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
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={`absolute inset-0 z-10 bg-black/30 transition-opacity duration-200 ease-out ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      <div
        aria-hidden={!open}
        className={`absolute left-0 top-0 bottom-0 z-20 w-[280px] bg-surface-2 border-r border-divider flex flex-col pt-[37px] transition-[transform,box-shadow] duration-200 ease-out ${
          open ? "translate-x-0 shadow-card" : "-translate-x-full"
        }`}
      >
        <div className="flex-none px-3 pt-4 pb-3">
          <button
            type="button"
            onClick={onNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-alt hover:bg-surface-alt-hover text-fg text-base font-medium transition-colors"
          >
            <PencilSquareIcon className="w-4 h-4" />
            <span>New chat</span>
          </button>
        </div>
        <div className="px-4 pb-2">
          <span className="text-xs font-semibold tracking-wider uppercase text-subtle">Recent</span>
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
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
    </>
  );
}
