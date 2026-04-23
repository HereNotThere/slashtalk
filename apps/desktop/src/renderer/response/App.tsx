import { useEffect, useState } from "react";
import type {
  AgentSummary,
  ChatHead,
  ResponseOpenPayload,
} from "../../shared/types";
import { AgentChat } from "../info/AgentPanel";
import { SendIcon } from "../shared/icons";

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

  return <MessageResponse message={payload?.message ?? ""} />;
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

function MessageResponse({ message }: { message: string }): JSX.Element {
  const [followUp, setFollowUp] = useState("");

  const handleFollowUpSend = (): void => {
    if (followUp.trim()) {
      console.log("Follow-up:", followUp);
      setFollowUp("");
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg">
      <div className="flex-1 overflow-auto px-lg py-lg space-y-lg min-w-0">
        {message && (
          <div className="flex justify-end mb-lg">
            <div className="px-4 py-2.5 rounded-2xl bg-surface text-fg shadow-sm">
              <p className="text-sm leading-relaxed">{message}</p>
            </div>
          </div>
        )}
        <p className="text-base leading-relaxed text-fg/90 break-words">
          Three people. Fei opened feat/auth-cleanup 1h ago and has a live
          session scaffolding the /signup route and OAuth buttons. PF is on
          the same branch renaming design tokens, with an active overlap in
          OAuthButtons.tsx. MJ closed the Auth0 → Firebase swap an hour ago;
          the token refresh path is the relevant piece for you.
        </p>

        <div className="flex flex-wrap gap-md">
          <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-surface">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-white text-sm font-semibold shrink-0">
              F
            </div>
            <span className="text-sm text-fg font-medium">
              Fei · feat/auth-cleanup
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-surface">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-sm font-semibold shrink-0">
              PF
            </div>
            <span className="text-sm text-fg font-medium">
              PF · feat/auth-cleanup
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-surface">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-700 to-amber-900 flex items-center justify-center text-white text-sm font-semibold shrink-0">
              M
            </div>
            <span className="text-sm text-fg font-medium">
              MJ · mj/firebase-migrate
            </span>
          </div>
        </div>
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
            placeholder="Ask a follow-up..."
            className="flex-1 bg-surface px-4 py-3 rounded-full border border-divider outline-none text-fg text-sm placeholder:text-muted focus:border-subtle transition-colors"
          />
          <button
            onClick={handleFollowUpSend}
            className="w-12 h-12 rounded-full bg-chat flex items-center justify-center text-white hover:opacity-90 transition-opacity shrink-0"
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
