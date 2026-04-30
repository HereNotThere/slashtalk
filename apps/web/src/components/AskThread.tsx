import { useEffect, useRef } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { SessionState, type ChatMessage, type SessionCard } from "@slashtalk/shared";
import { repoName, timeAgo } from "../lib/format";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";

interface AskThreadProps {
  messages: ChatMessage[];
  busy: boolean;
  busyHint?: string | null;
  onBack: () => void;
}

// Strip model-generated session citations; the cards below show the same info.
const CITATION_RE = /\[session:[^\]]+\]/g;

export function AskThread({ messages, busy, busyHint, onBack }: AskThreadProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-8 w-8 items-center justify-center rounded-full text-fg hover:bg-surface-alt"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <h2 className="m-0 text-sm font-semibold text-fg">Ask</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {busy ? (
            <div className="flex items-center gap-2 px-2 py-1 text-sm text-subtle">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
              {busyHint ? `${busyHint}…` : "Thinking…"}
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-primary px-3.5 py-2 text-sm text-primary-fg">
          {message.content}
        </div>
      </div>
    );
  }

  const cleaned = message.content.replace(CITATION_RE, "").trim();
  const cards = message.cards ?? [];
  const delegation = message.delegation;

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-2xl rounded-tl-md bg-surface-alt px-3.5 py-2.5 text-sm text-fg">
        {cleaned ? (
          <Markdown>{cleaned}</Markdown>
        ) : delegation ? (
          <p className="m-0 text-subtle">{delegation.task}</p>
        ) : (
          <p className="m-0 text-subtle">No response.</p>
        )}
      </div>

      {delegation ? (
        <div className="rounded-xl border border-divider bg-surface px-3.5 py-3 text-xs text-subtle">
          This question needs the desktop app to look inside the repo. Open Slashtalk on your
          computer to investigate.
        </div>
      ) : null}

      {cards.length > 0 ? (
        <div className="flex flex-col gap-2">
          {cards.map((c) => (
            <SessionCardRow key={c.id} card={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionCardRow({ card }: { card: SessionCard }): JSX.Element {
  const live = card.state === SessionState.BUSY || card.state === SessionState.ACTIVE;
  return (
    <a
      href={`/app/sessions/${card.id}`}
      className="flex items-center gap-3 rounded-xl border border-divider bg-surface px-3 py-2.5 text-fg no-underline hover:bg-surface-alt/40"
    >
      <Avatar src={card.user.avatarUrl} login={card.user.login} size={32} />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-semibold">
          {card.title || card.lastUserPrompt || "Session"}
        </p>
        <p className="m-0 mt-0.5 truncate text-xs text-subtle">
          @{card.user.login} · {repoName(card.repo)}
          {card.branch ? ` · ${card.branch}` : ""} · {timeAgo(card.lastTs)}
        </p>
      </div>
      {live ? (
        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold uppercase text-success">
          Live
        </span>
      ) : null}
    </a>
  );
}
