import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@slashtalk/shared";
import type {
  AgentSummary,
  ChatHead,
  ResponseOpenPayload,
} from "../../shared/types";
import { AgentChat } from "../info/AgentPanel";
import { SendIcon } from "../shared/icons";

const CITATION_TOKEN = /\[session:[0-9a-fA-F-]+\]/g;

const MARKDOWN_CLASSES =
  "prose prose-invert text-fg/90 break-words text-sm leading-relaxed " +
  "[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-code [&_code]:text-[0.9em] " +
  "[&_pre]:bg-code [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-auto " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_a]:text-link [&_a]:underline hover:[&_a]:text-link-hover";

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

  return (
    <MessageResponse
      message={payload?.kind === "message" ? payload.message : null}
    />
  );
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

function MessageResponse({ message }: { message: string | null }): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [followUp, setFollowUp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message) return;
    const initial: ChatMessage[] = [{ role: "user", content: message }];
    setMessages(initial);
    setFollowUp("");
    setError(null);
    void ask(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function ask(history: ChatMessage[]): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.chatheads.askChat(history);
      setMessages((prev) => [...prev, res.message]);
    } catch (err) {
      setError((err as Error).message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleFollowUpSend(): void {
    const trimmed = followUp.trim();
    if (!trimmed || loading) return;
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(next);
    setFollowUp("");
    void ask(next);
  }

  return (
    <div className="flex flex-col h-screen bg-bg">
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-lg py-lg space-y-lg min-w-0"
      >
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="px-4 py-2.5 rounded-2xl bg-surface text-fg shadow-sm max-w-[85%]">
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {m.content}
                </p>
              </div>
            </div>
          ) : (
            <div key={i} className={MARKDOWN_CLASSES}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {m.content.replace(CITATION_TOKEN, "")}
              </ReactMarkdown>
            </div>
          ),
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="inline-block w-2 h-2 rounded-full bg-muted animate-pulse" />
            <span>Thinking...</span>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-500 bg-red-500/10 px-3 py-2 rounded-md">
            {error}
          </div>
        )}
      </div>

      <div className="flex-none px-lg py-lg border-t border-divider">
        <div className="flex items-center gap-md">
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleFollowUpSend();
              }
            }}
            disabled={loading}
            placeholder={loading ? "Waiting for reply..." : "Ask a follow-up..."}
            className="flex-1 bg-surface px-4 py-3 rounded-full border border-divider outline-none text-fg text-sm placeholder:text-muted focus:border-subtle transition-colors disabled:opacity-50"
          />
          <button
            onClick={handleFollowUpSend}
            disabled={loading || !followUp.trim()}
            className="w-12 h-12 rounded-full bg-chat flex items-center justify-center text-white hover:opacity-90 transition-opacity shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
