import { Fragment, useEffect, useRef, useState } from "react";
import { CloseIcon } from "../shared/icons";
import { Markdown } from "../shared/Markdown";
import type {
  AgentMsg,
  ManagedAgentSessionRow,
  AgentSessionSummary,
  AgentStreamEvent,
  AgentSummary,
  AssistantBlock,
  ChatHead,
} from "../../shared/types";

const AGENT_PREFIX = "agent:";

export function AgentPanel({ head }: { head: ChatHead }): JSX.Element {
  const agentId = agentIdFromHead(head);
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [view, setView] = useState<"sessions" | "chat">("sessions");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [instance, setInstance] = useState(0);

  useEffect(() => {
    if (!agentId) return;
    void window.chatheads.agents.list().then((agents) => {
      setAgent(agents.find((item) => item.id === agentId) ?? null);
    });
    return window.chatheads.agents.onListChange((agents) => {
      setAgent(agents.find((item) => item.id === agentId) ?? null);
    });
  }, [agentId]);

  if (!agentId) {
    return <div className="px-lg py-md text-[12px] text-subtle">Agent not found.</div>;
  }

  const openSession = async (id: string): Promise<void> => {
    await window.chatheads.agents.selectSession(agentId, id);
    setSessionId(id);
    setSeed(null);
    setInstance((value) => value + 1);
    setView("chat");
  };

  const startSession = async (text: string): Promise<void> => {
    setSessionId(null);
    setSeed(text);
    setInstance((value) => value + 1);
    setView("chat");
    try {
      const session = await window.chatheads.agents.newSession(agentId);
      setSessionId(session.id);
    } catch (err) {
      console.error("newSession failed:", err);
    }
  };

  if (view === "chat") {
    return (
      <AgentChat
        key={instance}
        head={head}
        agent={agent}
        agentId={agentId}
        sessionId={sessionId}
        seed={seed}
        showPopOut
        onBack={() => {
          setView("sessions");
          setSessionId(null);
          setSeed(null);
        }}
      />
    );
  }

  return (
    <AgentSessions
      head={head}
      agent={agent}
      agentId={agentId}
      onOpenSession={(id) => void openSession(id)}
      onStartSession={(text) => void startSession(text)}
    />
  );
}

function agentIdFromHead(head: ChatHead): string | null {
  return head.id.startsWith(AGENT_PREFIX) ? head.id.slice(AGENT_PREFIX.length) : null;
}

function AgentHeader({
  head,
  agent,
  onBack,
  onPopOut,
  onClose = () => void window.chatheads.hideInfo(),
}: {
  head: ChatHead;
  agent: AgentSummary | null;
  onBack?: () => void;
  onPopOut?: () => void;
  onClose?: () => void;
}): JSX.Element {
  return (
    <div className="px-lg pt-lg pb-md flex items-start gap-md">
      {onBack && (
        <button
          onClick={onBack}
          title="Back to conversations"
          className="w-8 h-8 rounded-full flex items-center justify-center bg-surface hover:bg-surface-hover text-fg cursor-pointer shrink-0 mt-0.5"
        >
          ‹
        </button>
      )}
      <div className="w-12 h-12 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[22px] font-semibold shrink-0">
        {(head.label[0] ?? "A").toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-[17px] font-bold truncate flex-1 min-w-0">{head.label}</div>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-card border border-border text-muted">
            {(agent?.mode ?? "cloud") === "local" ? "Local" : "Cloud"}
          </span>
          {onPopOut && (
            <button
              onClick={onPopOut}
              className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-muted text-[11px] leading-none shrink-0 hover:opacity-60 transition-opacity cursor-pointer"
              aria-label="Open expanded agent chat"
              title="Open expanded chat"
            >
              ↗
            </button>
          )}
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-full bg-surface flex items-center justify-center text-muted text-[11px] leading-none shrink-0 hover:opacity-60 transition-opacity cursor-pointer"
            aria-label="Close"
          >
            x
          </button>
        </div>
        {agent?.description && (
          <div className="text-[12px] text-muted mt-0.5 truncate">{agent.description}</div>
        )}
        <div className="text-[11px] text-subtle mt-0.5 flex items-center gap-1 min-w-0">
          <span className="font-mono truncate">
            {(agent?.mode ?? "cloud") === "local"
              ? prettyCwd(agent?.cwd)
              : "Anthropic Managed Agent"}
          </span>
          {agent?.model && (
            <>
              <span>·</span>
              <span className="font-mono truncate">{agent.model}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentSessions({
  head,
  agent,
  agentId,
  onOpenSession,
  onStartSession,
}: {
  head: ChatHead;
  agent: AgentSummary | null;
  agentId: string;
  onOpenSession: (sessionId: string) => void;
  onStartSession: (text: string) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [pastSessions, setPastSessions] = useState<ManagedAgentSessionRow[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    void window.chatheads.agents.listSessions(agentId).then(setSessions);
    return window.chatheads.agents.onSessionsChange((payload) => {
      if (payload.agentId === agentId) setSessions(payload.sessions);
    });
  }, [agentId]);

  useEffect(() => {
    const refetch = (): void => {
      void window.chatheads
        .listAgentSessionsForAgent(agentId)
        .then((rows) => setPastSessions(rows.filter((row) => row.endedAt)));
    };
    refetch();
    const timer = setInterval(refetch, 15_000);
    return () => clearInterval(timer);
  }, [agentId]);

  useEffect(() => {
    for (const session of sessions) {
      if (!session.tokens) {
        void window.chatheads.agents.ensureSessionUsage(agentId, session.id);
      }
    }
  }, [agentId, sessions]);

  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  const submit = (): void => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onStartSession(text);
  };

  return (
    <div className="flex flex-col min-h-[190px] max-h-[560px]">
      <AgentHeader head={head} agent={agent} />
      <Divider />
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && pastSessions.length === 0 ? (
          <div className="px-lg py-md text-subtle text-[12px]">
            No conversations yet. Send a message below to start one.
          </div>
        ) : (
          <>
            {sorted.map((session, i) => (
              <Fragment key={session.id}>
                {i > 0 && <div className="mx-lg h-px bg-divider" />}
                <SessionButton
                  session={session}
                  onOpen={() => onOpenSession(session.id)}
                  onRemove={() => void window.chatheads.agents.removeSession(agentId, session.id)}
                />
              </Fragment>
            ))}
            {pastSessions.length > 0 && (
              <div className="px-lg py-md">
                <div className="text-[10px] uppercase tracking-wider text-subtle mb-1">
                  Past team summaries
                </div>
                <div className="space-y-1">
                  {pastSessions.map((row) => (
                    <PastSummary key={row.sessionId} row={row} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <Divider />
      <div className="px-lg py-md flex items-center gap-2">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={`Talk to ${head.label}...`}
          className="flex-1 bg-bg border border-border rounded-full px-3 py-1.5 text-[13px] outline-none focus:border-accent"
        />
        <button
          onClick={submit}
          disabled={!input.trim()}
          className="bg-fg text-bg rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function SessionButton({
  session,
  onOpen,
  onRemove,
}: {
  session: AgentSessionSummary;
  onOpen: () => void;
  onRemove: () => void;
}): JSX.Element {
  const tokens = (session.tokens?.input ?? 0) + (session.tokens?.output ?? 0);
  return (
    <div className="group relative">
      <button
        onClick={onOpen}
        className="w-full text-left px-lg py-md pr-12 hover:bg-surface/60 transition-colors cursor-pointer"
      >
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-fg truncate">
            {session.title ?? "New conversation"}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-subtle min-w-0">
            <span className="shrink-0">{fmtAgo(Date.now() - session.createdAt)} ago</span>
            {tokens > 0 && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0">{fmtTokens(tokens)} tokens</span>
              </>
            )}
          </div>
        </div>
      </button>
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-subtle text-[14px] leading-none opacity-100 group-hover:opacity-0 transition-opacity"
      >
        ›
      </span>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        title="Remove conversation"
        aria-label="Remove conversation"
        className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center text-subtle hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function PastSummary({ row }: { row: ManagedAgentSessionRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      className="w-full text-left bg-surface rounded-xl px-3 py-2 hover:bg-surface-hover"
    >
      <div className="text-[12px] font-medium truncate">{row.name ?? "Archived session"}</div>
      <div className="text-[11px] text-subtle">{new Date(row.lastActivity).toLocaleString()}</div>
      {open && (
        <div className="mt-2 text-[12px] text-muted whitespace-pre-wrap leading-snug">
          {row.summary ?? "No summary captured."}
        </div>
      )}
    </button>
  );
}

export function AgentChat({
  head,
  agent,
  agentId,
  sessionId,
  seed,
  onBack,
  fullHeight = false,
  showPopOut = false,
  onClose,
}: {
  head: ChatHead;
  agent: AgentSummary | null;
  agentId: string;
  sessionId: string | null;
  seed: string | null;
  onBack: () => void;
  fullHeight?: boolean;
  showPopOut?: boolean;
  onClose?: () => void;
}): JSX.Element {
  const [msgs, setMsgs] = useState<AgentMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(Boolean(seed));
  const seedSent = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (seed) {
      setMsgs([
        { role: "user", text: seed },
        {
          role: "assistant",
          blocks: [],
          phase: sessionId ? "Working..." : "Starting conversation...",
          done: false,
        },
      ]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (!sessionId) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    window.chatheads.agents
      .history(agentId, sessionId)
      .then((page) => {
        if (cancelled) return;
        setMsgs(page.msgs);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (!cancelled) setMsgs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, seed, sessionId]);

  useEffect(() => {
    if (!sessionId || !seed || seedSent.current) return;
    seedSent.current = true;
    void sendText(seed, { appendOptimistic: false });
    // sendText closes over current state intentionally; guard prevents repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, seed]);

  useEffect(() => {
    return window.chatheads.agents.onEvent((event) => {
      if (event.agentId !== agentId) return;
      setMsgs((prev) => applyEvent(prev, event));
      if (event.kind === "done" || event.kind === "error") setBusy(false);
    });
  }, [agentId]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const loadOlder = async (): Promise<void> => {
    if (!nextCursor) return;
    const page = await window.chatheads.agents.history(agentId, sessionId, nextCursor);
    setMsgs((prev) => [...page.msgs, ...prev]);
    setNextCursor(page.nextCursor);
  };

  const sendText = async (
    text: string,
    opts: { appendOptimistic?: boolean } = {},
  ): Promise<void> => {
    if (!sessionId) return;
    setBusy(true);
    if (opts.appendOptimistic !== false) {
      setMsgs((prev) => [
        ...prev,
        { role: "user", text },
        { role: "assistant", blocks: [], phase: "Working...", done: false },
      ]);
    } else {
      setMsgs((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant" || last.done) return prev;
        return [...prev.slice(0, -1), { ...last, phase: "Working..." }];
      });
    }
    try {
      await window.chatheads.agents.send(agentId, text, sessionId);
    } catch (err) {
      setMsgs((prev) =>
        applyEvent(prev, {
          kind: "error",
          agentId,
          message: (err as Error).message,
        }),
      );
      setBusy(false);
    }
  };

  const submit = (): void => {
    const text = input.trim();
    if (!text || busy || !sessionId) return;
    setInput("");
    void sendText(text);
  };

  return (
    <div
      className={
        fullHeight ? "flex flex-col h-screen" : "flex flex-col min-h-[240px] max-h-[620px]"
      }
    >
      <AgentHeader
        head={head}
        agent={agent}
        onBack={onBack}
        onClose={onClose}
        onPopOut={
          showPopOut && sessionId
            ? () => void window.chatheads.agents.popOut(agentId, sessionId)
            : undefined
        }
      />
      <Divider />
      <div
        ref={transcriptRef}
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < 80) void loadOlder();
        }}
        className="flex-1 overflow-y-auto px-lg py-md space-y-3 text-[13px]"
      >
        {loading ? (
          <div className="text-subtle text-[12px]">Loading conversation...</div>
        ) : msgs.length === 0 ? (
          <div className="text-subtle text-[12px]">No messages yet.</div>
        ) : (
          msgs.map((msg, index) => <MsgRow key={index} msg={msg} />)
        )}
      </div>
      <Divider />
      <div className="px-lg py-md flex items-center gap-2">
        <input
          value={input}
          disabled={!sessionId}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={sessionId ? `Message ${head.label}...` : "Starting..."}
          className="flex-1 bg-bg border border-border rounded-full px-3 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-60"
        />
        <button
          onClick={submit}
          disabled={!input.trim() || busy || !sessionId}
          className="bg-fg text-bg rounded-full px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

function MsgRow({ msg }: { msg: AgentMsg }): JSX.Element {
  if (msg.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] bg-fg text-bg rounded-2xl rounded-br-sm px-3 py-2 whitespace-pre-wrap">
        {msg.text}
      </div>
    );
  }
  return (
    <div className="mr-auto max-w-[92%] text-fg">
      <div className="space-y-2">
        {msg.blocks.map((block, index) => (
          <AssistantBlockView key={index} block={block} />
        ))}
        {msg.phase && <div className="text-[11px] text-subtle italic">{msg.phase}</div>}
      </div>
    </div>
  );
}

function AssistantBlockView({ block }: { block: AssistantBlock }): JSX.Element {
  if (block.kind === "text") {
    return (
      <div className="bg-surface rounded-2xl rounded-bl-sm px-3 py-2">
        <Markdown>{block.text}</Markdown>
      </div>
    );
  }
  if (block.kind === "thinking") {
    return <div className="text-[12px] text-subtle italic">Thinking...</div>;
  }
  return (
    <div className="bg-surface border border-border rounded-xl px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-subtle">
        Tool · {block.server ? `${block.server}/` : ""}
        {block.name} · {block.status}
      </div>
      {block.resultSummary && (
        <div className="mt-1 text-[12px] text-muted whitespace-pre-wrap">{block.resultSummary}</div>
      )}
    </div>
  );
}

function applyEvent(prev: AgentMsg[], event: AgentStreamEvent): AgentMsg[] {
  const next = [...prev];
  const last = next[next.length - 1];
  let assistant: Extract<AgentMsg, { role: "assistant" }>;
  if (last?.role === "assistant" && !last.done) {
    assistant = { ...last, blocks: [...last.blocks] };
    next[next.length - 1] = assistant;
  } else {
    assistant = { role: "assistant", blocks: [], done: false };
    next.push(assistant);
  }

  if (event.kind === "text") {
    const tail = assistant.blocks[assistant.blocks.length - 1];
    if (tail?.kind === "text") {
      assistant.blocks[assistant.blocks.length - 1] = {
        ...tail,
        text: tail.text + event.text,
      };
    } else {
      assistant.blocks.push({ kind: "text", text: event.text });
    }
    assistant.phase = null;
  } else if (event.kind === "thinking") {
    assistant.blocks.push({ kind: "thinking" });
    assistant.phase = "Thinking...";
  } else if (event.kind === "tool_use") {
    assistant.blocks.push({
      kind: "tool_use",
      id: event.id,
      name: event.name,
      server: event.server,
      input: event.input,
      status: "running",
    });
  } else if (event.kind === "tool_result") {
    assistant.blocks = assistant.blocks.map((block) =>
      block.kind === "tool_use" && block.id === event.toolUseId
        ? {
            ...block,
            status: event.isError ? "error" : "ok",
            resultSummary: event.summary,
          }
        : block,
    );
  } else if (event.kind === "phase") {
    assistant.phase = event.label;
  } else if (event.kind === "done") {
    assistant.done = true;
    assistant.phase = null;
  } else if (event.kind === "error") {
    assistant.blocks.push({ kind: "text", text: `[error: ${event.message}]` });
    assistant.done = true;
    assistant.phase = null;
  }

  return next;
}

function Divider(): JSX.Element {
  return <div className="mx-lg h-px bg-divider" />;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function fmtAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function prettyCwd(cwd: string | undefined): string {
  if (!cwd) return "~";
  const home = cwd.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (home) return `~${home[1] ?? ""}`;
  return cwd;
}
