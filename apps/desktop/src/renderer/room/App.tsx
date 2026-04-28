import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApplyPatchResult,
  BackendUser,
  RoomMember,
  RoomSnapshot,
  RoomStatus,
} from "../../shared/types";
import { Button } from "../shared/Button";
import { Markdown } from "../shared/Markdown";
import { DiffView } from "./DiffView";

interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function getRoomIdFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  // Accept both "#abc-123" and "#roomId=abc-123" — the main process uses the
  // bare form via loadRenderer(win, "room", roomId).
  const params = new URLSearchParams(raw);
  return params.get("roomId") ?? raw;
}

function statusLabel(status: RoomStatus): string {
  switch (status) {
    case "provisioning":
      return "Provisioning";
    case "ready":
      return "Ready";
    case "paused":
      return "Paused";
    case "destroyed":
      return "Destroyed";
    case "failed":
      return "Failed";
  }
}

function statusClasses(status: RoomStatus): string {
  switch (status) {
    case "ready":
      return "bg-success/15 text-success";
    case "provisioning":
      return "bg-accent/15 text-accent-fg";
    case "paused":
      return "bg-surface-strong text-subtle";
    case "destroyed":
      return "bg-surface-strong text-muted";
    case "failed":
      return "bg-danger/15 text-danger";
  }
}

function MemberAvatar({ member, size = 24 }: { member: RoomMember; size?: number }): JSX.Element {
  const initial = (member.displayName ?? member.githubLogin ?? "?")[0]?.toUpperCase() ?? "?";
  return (
    <div
      className="rounded-full bg-bubble inline-flex items-center justify-center overflow-hidden"
      style={{ width: size, height: size }}
      title={member.displayName ?? member.githubLogin}
    >
      {member.avatarUrl ? (
        <img src={member.avatarUrl} alt="" className="w-full h-full" />
      ) : (
        <span className="text-xs font-semibold text-fg">{initial}</span>
      )}
    </div>
  );
}

function TypingIndicator(): JSX.Element {
  return (
    <div className="flex items-center gap-1 text-subtle text-sm">
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-subtle" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-subtle" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-subtle" />
      <span className="ml-1">Claude is working</span>
    </div>
  );
}

function ChatBubble({
  isSelf,
  authorMember,
  text,
}: {
  isSelf: boolean;
  authorMember: RoomMember | null;
  text: string;
}): JSX.Element {
  return (
    <div className={"flex gap-2 " + (isSelf ? "flex-row-reverse" : "flex-row")}>
      {authorMember && <MemberAvatar member={authorMember} size={28} />}
      <div className="flex flex-col gap-0.5 max-w-[75%]">
        {authorMember && !isSelf && (
          <div className="text-xs text-subtle">
            {authorMember.displayName ?? authorMember.githubLogin}
          </div>
        )}
        <div
          className={
            "px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words " +
            (isSelf ? "bg-accent text-accent-fg rounded-br-sm" : "bg-surface text-fg rounded-bl-sm")
          }
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function AgentBubble({
  text,
  diffStat,
  onShowDiff,
}: {
  text: string;
  diffStat?: DiffStat;
  onShowDiff?: () => void;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      <div className="rounded-full bg-primary/20 text-primary inline-flex items-center justify-center w-7 h-7 text-xs font-semibold shrink-0">
        C
      </div>
      <div className="flex flex-col gap-1.5 max-w-[85%]">
        <div className="text-xs text-subtle">Claude</div>
        <div className="px-3 py-2 rounded-2xl rounded-bl-sm bg-surface text-fg text-sm">
          <Markdown>{text || "_(no response)_"}</Markdown>
        </div>
        {diffStat && diffStat.filesChanged > 0 && onShowDiff && (
          <button
            type="button"
            onClick={onShowDiff}
            className="self-start flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border border-border bg-surface hover:bg-surface-hover transition-colors"
          >
            <span>
              {diffStat.filesChanged} file{diffStat.filesChanged === 1 ? "" : "s"} changed
            </span>
            <span className="text-success font-mono">+{diffStat.insertions}</span>
            <span className="text-danger font-mono">-{diffStat.deletions}</span>
            <span className="text-subtle">— show diff</span>
          </button>
        )}
      </div>
    </div>
  );
}

function SystemPill({ text }: { text: string }): JSX.Element {
  return (
    <div className="self-center text-xs text-subtle bg-surface-strong/60 px-2 py-1 rounded-full">
      {text}
    </div>
  );
}

export function App(): JSX.Element {
  const roomId = useMemo(getRoomIdFromHash, []);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [me, setMe] = useState<BackendUser | null>(null);
  const [agentDeltaText, setAgentDeltaText] = useState("");
  const [diffPanel, setDiffPanel] = useState<{ patch: string; repoId: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const myUserId = useMemo(() => {
    if (!me || !snapshot) return null;
    const mine = snapshot.members.find((m) => m.githubLogin === me.githubLogin);
    return mine?.userId ?? null;
  }, [me, snapshot]);

  const memberById = useMemo(() => {
    const map = new Map<number, RoomMember>();
    for (const m of snapshot?.members ?? []) map.set(m.userId, m);
    return map;
  }, [snapshot?.members]);

  const isAgentWorking = useMemo(() => {
    const msgs = snapshot?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind === "agent_typing") return true;
      if (m.kind === "agent_message") return false;
      // Crash recovery: a system message (agent_error / failed) ends the turn
      // even without an agent_message — otherwise the input stays locked.
      if (m.kind === "system") {
        const body = m.body as { kind?: string };
        if (body.kind === "agent_error" || body.kind === "failed") return false;
      }
    }
    return false;
  }, [snapshot?.messages]);

  const status = snapshot?.room.status;
  const inputBlocked =
    !status ||
    status === "provisioning" ||
    status === "destroyed" ||
    status === "failed" ||
    isAgentWorking;

  // Initial load + auth identity.
  useEffect(() => {
    if (!roomId) return;
    void window.chatheads.rooms.get(roomId).then(setSnapshot);
    void window.chatheads.backend.getAuthState().then((s) => {
      if (s.signedIn) setMe(s.user);
    });
  }, [roomId]);

  // Mirror the room name into the window title so the OS chrome reads
  // meaningfully (Electron mirrors document.title to BrowserWindow title).
  useEffect(() => {
    if (snapshot?.room.name) {
      document.title = snapshot.room.name;
    }
  }, [snapshot?.room.name]);

  // The WS handler subscribes to room:<id> at *connect* time, so a freshly-
  // created room's events (status, messages, member joins) are missed by an
  // already-open WS connection. We poll the snapshot every 3s while the
  // window is open — this catches your own sent messages, the agent's reply,
  // status flips, and member joins regardless of WS coverage. Cheap: one
  // /api/rooms/:id call returning a small JSON payload.
  useEffect(() => {
    if (!roomId) return;
    const t = setInterval(() => {
      void window.chatheads.rooms.get(roomId).then(setSnapshot);
    }, 3_000);
    return () => clearInterval(t);
  }, [roomId]);

  // WS subscriptions.
  useEffect(() => {
    if (!roomId) return;
    const offMsg = window.chatheads.rooms.onMessageCreated((msg) => {
      if (msg.roomId !== roomId) return;
      setSnapshot((prev) => (prev ? { ...prev, messages: [...prev.messages, msg.message] } : prev));
      if (msg.message.kind === "agent_message" || msg.message.kind === "agent_typing") {
        // New turn boundary — clear the live delta accumulator.
        if (msg.message.kind === "agent_message") setAgentDeltaText("");
      }
    });
    const offDelta = window.chatheads.rooms.onAgentDelta((msg) => {
      if (msg.roomId !== roomId) return;
      const event = msg.event as
        | { type?: string; message?: { content?: Array<{ type: string; text?: string }> } }
        | undefined;
      if (event?.type === "assistant") {
        const chunks =
          event.message?.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("") ?? "";
        if (chunks) setAgentDeltaText((prev) => prev + chunks);
      }
    });
    const offStatus = window.chatheads.rooms.onStatusChanged((msg) => {
      if (msg.roomId !== roomId) return;
      setSnapshot((prev) =>
        prev ? { ...prev, room: { ...prev.room, status: msg.status } } : prev,
      );
    });
    const offJoin = window.chatheads.rooms.onMemberJoined((msg) => {
      if (msg.roomId !== roomId) return;
      // Member list changed — refetch to pick up the new row with profile data.
      void window.chatheads.rooms.get(roomId).then(setSnapshot);
    });
    return () => {
      offMsg();
      offDelta();
      offStatus();
      offJoin();
    };
  }, [roomId]);

  // Auto-scroll to bottom on new messages / streaming text.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot?.messages.length, agentDeltaText]);

  const send = useCallback(
    async (mode: "chat" | "agent") => {
      if (!roomId) return;
      const text = input.trim();
      if (!text) return;
      setSending(true);
      try {
        if (mode === "agent") {
          await window.chatheads.rooms.postAgent(roomId, text);
        } else {
          await window.chatheads.rooms.postMessage(roomId, text);
        }
        setInput("");
      } catch (err) {
        setToast({ kind: "err", text: (err as Error).message });
      } finally {
        setSending(false);
      }
    },
    [input, roomId],
  );

  const onShowDiff = useCallback(async () => {
    if (!roomId || !snapshot) return;
    try {
      const patch = await window.chatheads.rooms.patch(roomId);
      setDiffPanel({ patch, repoId: snapshot.room.repoId });
    } catch (err) {
      setToast({ kind: "err", text: (err as Error).message });
    }
  }, [roomId, snapshot]);

  const onApply = useCallback(async () => {
    if (!roomId || !diffPanel) return;
    setApplying(true);
    try {
      const result: ApplyPatchResult = await window.chatheads.rooms.applyPatchLocally(
        roomId,
        diffPanel.repoId,
      );
      if (result.applied) {
        setToast({ kind: "ok", text: "Applied to local repo" });
      } else {
        setToast({ kind: "err", text: result.error ?? "git apply failed" });
      }
    } catch (err) {
      setToast({ kind: "err", text: (err as Error).message });
    } finally {
      setApplying(false);
    }
  }, [roomId, diffPanel]);

  const onDownload = useCallback(async () => {
    if (!diffPanel) return;
    await window.chatheads.copyText(diffPanel.patch);
    setToast({ kind: "ok", text: "Patch copied to clipboard" });
  }, [diffPanel]);

  const isOwner = !!snapshot && myUserId !== null && snapshot.room.createdBy === myUserId;

  const onDestroy = useCallback(async () => {
    if (!roomId || !snapshot) return;
    if (
      !confirm(
        `Destroy "${snapshot.room.name}"? The sandbox will be killed and the room removed for everyone in the org.`,
      )
    )
      return;
    try {
      await window.chatheads.rooms.delete(roomId);
      window.close();
    } catch (err) {
      setToast({ kind: "err", text: (err as Error).message });
    }
  }, [roomId, snapshot]);

  if (!roomId) {
    return (
      <div className="h-screen flex items-center justify-center text-subtle">
        No room id provided.
      </div>
    );
  }

  const room = snapshot?.room;
  const messages = snapshot?.messages ?? [];

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold truncate">{room?.name ?? "Loading…"}</h1>
            {room && (
              <span
                className={
                  "text-xs uppercase tracking-wider px-1.5 py-0.5 rounded-full " +
                  statusClasses(room.status)
                }
              >
                {statusLabel(room.status)}
              </span>
            )}
          </div>
          {room?.description && (
            <div className="text-xs text-subtle truncate">{room.description}</div>
          )}
        </div>
        <div className="flex items-center -space-x-2">
          {(snapshot?.members ?? []).slice(0, 5).map((m) => (
            <div key={m.userId} className="ring-2 ring-card rounded-full">
              <MemberAvatar member={m} size={26} />
            </div>
          ))}
          {(snapshot?.members.length ?? 0) > 5 && (
            <div className="text-xs text-subtle ml-2">+{(snapshot?.members.length ?? 0) - 5}</div>
          )}
        </div>
        {isOwner && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onDestroy()}
            className="text-danger ml-2"
            title="Destroy this room — kills the sandbox and removes it for the whole org"
          >
            Destroy
          </Button>
        )}
      </header>

      {/* Message log */}
      <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {status === "provisioning" && messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 mt-12 text-subtle">
            <div
              className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent"
              style={{ animation: "spin 1.2s linear infinite" }}
            />
            <div className="text-sm">
              Setting up sandbox — cloning the repo and starting Claude…
            </div>
            <div className="text-xs">Usually takes about 30 seconds.</div>
          </div>
        )}
        {messages.map((msg) => {
          if (msg.kind === "system") {
            const body = msg.body as { kind?: string; error?: string };
            const text =
              body.kind === "ready"
                ? "Sandbox ready — agent online"
                : body.kind === "failed"
                  ? `Provisioning failed: ${body.error ?? "unknown"}`
                  : body.kind === "agent_error"
                    ? `Agent error: ${body.error ?? "unknown"}`
                    : (body.kind ?? "system");
            return <SystemPill key={msg.seq} text={text} />;
          }
          if (msg.kind === "chat") {
            const body = msg.body as { text: string };
            const author = msg.authorUserId ? (memberById.get(msg.authorUserId) ?? null) : null;
            const isSelf = msg.authorUserId !== null && msg.authorUserId === myUserId;
            return (
              <ChatBubble key={msg.seq} isSelf={isSelf} authorMember={author} text={body.text} />
            );
          }
          if (msg.kind === "agent_typing") {
            return null; // Rendered separately at the bottom while in flight.
          }
          if (msg.kind === "agent_message") {
            const body = msg.body as { text: string; diffStat?: DiffStat; exitCode?: number };
            return (
              <AgentBubble
                key={msg.seq}
                text={body.text}
                diffStat={body.diffStat}
                onShowDiff={
                  body.diffStat && body.diffStat.filesChanged > 0 ? onShowDiff : undefined
                }
              />
            );
          }
          return null;
        })}
        {isAgentWorking && (
          <div className="flex gap-2">
            <div className="rounded-full bg-primary/20 text-primary inline-flex items-center justify-center w-7 h-7 text-xs font-semibold shrink-0">
              C
            </div>
            <div className="flex flex-col gap-1.5 max-w-[85%]">
              <TypingIndicator />
              {agentDeltaText && (
                <div className="px-3 py-2 rounded-2xl rounded-bl-sm bg-surface/60 text-fg text-sm whitespace-pre-wrap">
                  {agentDeltaText}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Diff panel — slides in below the log when active */}
      {diffPanel && (
        <div className="border-t border-border bg-bg max-h-[55vh] overflow-y-auto p-4 shrink-0">
          <div className="flex items-center mb-2">
            <span className="text-sm font-semibold">Working tree diff</span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setDiffPanel(null)}>
              Close
            </Button>
          </div>
          <DiffView
            patch={diffPanel.patch}
            onApply={onApply}
            onDownload={onDownload}
            applying={applying}
          />
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={
            "px-4 py-2 text-sm shrink-0 " +
            (toast.kind === "ok" ? "text-success bg-success/10" : "text-danger bg-danger/10")
          }
        >
          {toast.text}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-3 bg-card shrink-0 flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send("chat");
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send("agent");
            }
          }}
          disabled={inputBlocked}
          placeholder={
            status === "provisioning"
              ? "Setting up sandbox…"
              : status === "destroyed"
                ? "This room has been destroyed."
                : status === "failed"
                  ? "Provisioning failed — create a new room."
                  : isAgentWorking
                    ? "Claude is working — wait for the response…"
                    : "Ask Claude or chat with teammates…"
          }
          rows={3}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-sm outline-none focus:border-primary resize-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-subtle">
            <kbd className="px-1 py-0.5 bg-surface rounded text-[10px]">Enter</kbd> Ask Claude ·{" "}
            <kbd className="px-1 py-0.5 bg-surface rounded text-[10px]">⌘↵</kbd> Chat only
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void send("chat")}
            disabled={!input.trim() || sending || inputBlocked}
          >
            Chat
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void send("agent")}
            disabled={!input.trim() || sending || inputBlocked}
          >
            {sending ? "Sending…" : "Ask Claude"}
          </Button>
        </div>
      </div>
    </div>
  );
}
