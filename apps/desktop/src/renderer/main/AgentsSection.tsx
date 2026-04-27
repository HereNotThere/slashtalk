import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/Button";
import { AGENT_TEMPLATES, type AgentTemplate } from "../shared/agentTemplates";
import { CwdPicker, McpServersField } from "../shared/AgentRuntimeFields";
import { Toggle } from "../shared/Button";
import type {
  AgentMode,
  AgentSummary,
  AgentVisibility,
  BackendAuthState,
  McpServerInput,
  TrackedRepo,
} from "../../shared/types";

type Toast = { kind: "ok" | "err"; text: string } | null;
const DEFAULT_CLOUD_MODEL = "claude-haiku-4-5";
const DEFAULT_LOCAL_MODEL = "claude-sonnet-4-6";

export function AgentsSection({
  openCreatorSignal = 0,
}: {
  openCreatorSignal?: number;
}): JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [trackedRepos, setTrackedRepos] = useState<TrackedRepo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    const offAuth = window.chatheads.backend.onAuthState(setAuth);
    void window.chatheads.agents.isConfigured().then(setConfigured);
    void window.chatheads.agents.list().then(setAgents);
    void window.chatheads.backend.listTrackedRepos().then(setTrackedRepos);
    const offCfg = window.chatheads.agents.onConfiguredChange(setConfigured);
    const offList = window.chatheads.agents.onListChange(setAgents);
    const offRepos = window.chatheads.backend.onTrackedReposChange(setTrackedRepos);
    return () => {
      offAuth();
      offCfg();
      offList();
      offRepos();
    };
  }, []);

  useEffect(() => {
    if (openCreatorSignal === 0) return;
    setEditingAgentId(null);
    setShowCreate(true);
    sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [openCreatorSignal]);

  const removeAgent = async (agent: AgentSummary): Promise<void> => {
    if (!confirm(`Remove "${agent.name}"?`)) return;
    setToast(null);
    try {
      await window.chatheads.agents.remove(agent.id);
      setToast({ kind: "ok", text: `Removed ${agent.name}` });
    } catch (err) {
      setToast({ kind: "err", text: (err as Error).message });
    }
  };

  return (
    <section ref={sectionRef} className="bg-surface rounded-2xl p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <div>
          <h2 className="m-0 text-base font-semibold">Agents</h2>
          <div className="text-sm text-subtle">
            Local Claude Code agents and cloud Managed Agents.
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowKeyForm((v) => !v)}
          className="ml-auto"
        >
          {configured ? "API key" : "Add API key"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={!showCreate ? <PlusIcon className="w-4 h-4" /> : undefined}
          onClick={() => {
            setEditingAgentId(null);
            setShowCreate((v) => !v);
          }}
          disabled={!auth.signedIn}
          title={auth.signedIn ? "Create a local or cloud agent" : "Sign in to Slashtalk first"}
        >
          {showCreate ? "Close" : "New agent"}
        </Button>
      </div>

      {!auth.signedIn && (
        <div className="text-sm text-subtle">
          Sign in to Slashtalk first. Agents use your slashtalk device key for MCP and team-session
          summaries.
        </div>
      )}

      {showKeyForm && (
        <ApiKeyForm
          configured={configured === true}
          onDone={() => setShowKeyForm(false)}
          onToast={setToast}
        />
      )}

      {showCreate && auth.signedIn && (
        <CreateAgentForm
          cloudAvailable={configured === true}
          trackedRepos={trackedRepos}
          onCreated={() => {
            setShowCreate(false);
            setToast({ kind: "ok", text: "Agent created" });
          }}
          onError={(message) => setToast({ kind: "err", text: message })}
        />
      )}

      {editingAgentId && (
        <EditAgentForm
          agent={agents.find((agent) => agent.id === editingAgentId) ?? null}
          trackedRepos={trackedRepos}
          onSaved={(agentName) => {
            setEditingAgentId(null);
            setToast({ kind: "ok", text: `Saved ${agentName}` });
          }}
          onCancel={() => setEditingAgentId(null)}
          onError={(message) => setToast({ kind: "err", text: message })}
        />
      )}

      <div className="flex flex-col gap-1.5 mt-3">
        {agents.length === 0 ? (
          <div className="text-sm text-subtle">
            No agents yet. Create a local agent without an API key, or add an Anthropic key to
            enable cloud agents.
          </div>
        ) : (
          agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => {
                setShowCreate(false);
                setEditingAgentId(agent.id);
              }}
              onRemove={() => void removeAgent(agent)}
            />
          ))
        )}
      </div>

      {toast && (
        <div
          className={`text-sm mt-3 leading-snug ${
            toast.kind === "ok" ? "text-success" : "text-danger"
          }`}
        >
          {toast.text}
        </div>
      )}
    </section>
  );
}

function AgentRow({
  agent,
  onEdit,
  onRemove,
}: {
  agent: AgentSummary;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-surface-alt rounded-lg">
      <span className="w-7 h-7 rounded-full bg-primary-soft text-primary inline-flex items-center justify-center text-base font-semibold shrink-0">
        {(agent.name[0] ?? "A").toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium truncate">{agent.name}</div>
        <div className="text-xs text-subtle truncate">{agent.description || agent.model}</div>
      </div>
      <span className="text-xs uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted">
        {(agent.mode ?? "cloud") === "local" ? "Local" : "Cloud"}
      </span>
      <span className="text-xs uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted">
        {agent.visibility ?? "private"}
      </span>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove">
        ×
      </Button>
    </div>
  );
}

function ApiKeyForm({
  configured,
  onDone,
  onToast,
}: {
  configured: boolean;
  onDone: () => void;
  onToast: (toast: Toast) => void;
}): JSX.Element {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    onToast(null);
    try {
      await window.chatheads.agents.setApiKey(trimmed);
      setKey("");
      onToast({ kind: "ok", text: "Anthropic API key saved" });
      onDone();
    } catch (err) {
      onToast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    onToast(null);
    try {
      await window.chatheads.agents.clearApiKey();
      onToast({ kind: "ok", text: "Stored API key removed" });
      onDone();
    } catch (err) {
      onToast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface-alt border border-border rounded-xl p-3 mb-3">
      <div className="text-sm text-subtle mb-2">
        Paste an Anthropic API key to enable cloud agents. Local agents do not require this.
      </div>
      <div className="flex gap-1.5">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="sk-ant-..."
          className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-primary"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || !key.trim()}
        >
          {busy ? "Checking..." : "Save"}
        </Button>
        {configured && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clear()}
            disabled={busy}
            className="text-danger hover:text-danger"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateAgentForm({
  cloudAvailable,
  trackedRepos,
  onCreated,
  onError,
}: {
  cloudAvailable: boolean;
  trackedRepos: TrackedRepo[];
  onCreated: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<AgentMode>(cloudAvailable ? "cloud" : "local");
  const [model, setModel] = useState(cloudAvailable ? DEFAULT_CLOUD_MODEL : DEFAULT_LOCAL_MODEL);
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [cwd, setCwd] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerInput[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cloudAvailable && mode === "cloud") setMode("local");
  }, [cloudAvailable, mode]);

  useEffect(() => {
    setModel((current) => {
      if (mode === "cloud" && current === DEFAULT_LOCAL_MODEL) {
        return DEFAULT_CLOUD_MODEL;
      }
      if (mode === "local" && current === DEFAULT_CLOUD_MODEL) {
        return DEFAULT_LOCAL_MODEL;
      }
      return current;
    });
  }, [mode]);

  const applyTemplate = (template: AgentTemplate): void => {
    setName(template.name);
    setDescription(template.description);
    setPrompt(template.systemPrompt);
    setMcpServers(template.mcpServers ?? []);
  };

  const canSubmit = name.trim() && prompt.trim() && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await window.chatheads.agents.create({
        name: name.trim(),
        description: description.trim() || undefined,
        systemPrompt: prompt.trim(),
        model: model.trim() || undefined,
        mode,
        visibility,
        ...(mode === "local"
          ? { cwd: cwd.trim() || undefined }
          : { mcpServers: mcpServers.length > 0 ? mcpServers : undefined }),
      });
      onCreated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface-alt border border-border rounded-xl p-3 mb-3 flex flex-col gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-subtle mb-1.5">
          Templates
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {AGENT_TEMPLATES.map((template) => (
            <button
              key={template.name}
              type="button"
              onClick={() => applyTemplate(template)}
              title={template.description}
              className="text-xs px-2 py-0.5 rounded-full bg-surface-alt border border-border cursor-pointer hover:bg-surface-alt-hover"
            >
              {template.name}
            </button>
          ))}
        </div>
      </div>

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Spec sync"
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary"
        />
      </Field>
      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Keeps API spec and handler code aligned"
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary"
        />
      </Field>
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Watch for drift between docs/api-spec.md and handlers. Open a small PR when they diverge."
          rows={4}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary resize-none leading-snug"
        />
      </Field>
      <Field label="Model">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={mode === "local" ? DEFAULT_LOCAL_MODEL : DEFAULT_CLOUD_MODEL}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base font-mono outline-none focus:border-primary"
        />
      </Field>
      <Field label="Runtime">
        <div className="flex gap-1.5">
          <Toggle
            active={mode === "cloud"}
            onClick={() => setMode("cloud")}
            disabled={!cloudAvailable}
            title={
              cloudAvailable
                ? "Runs on Anthropic's servers."
                : "Add an Anthropic API key to enable cloud agents."
            }
          >
            Cloud
          </Toggle>
          <Toggle
            active={mode === "local"}
            onClick={() => setMode("local")}
            title="Runs in this app on your machine."
          >
            Local
          </Toggle>
        </div>
      </Field>
      <Field label="Visibility">
        <div className="flex gap-1.5">
          <Toggle
            active={visibility === "private"}
            onClick={() => setVisibility("private")}
            title="Sessions stay on your machine."
          >
            Private
          </Toggle>
          <Toggle
            active={visibility === "team"}
            onClick={() => setVisibility("team")}
            title="Teammates see post-session summaries."
          >
            Team
          </Toggle>
        </div>
      </Field>
      {mode === "local" ? (
        <Field label="Working directory">
          <CwdPicker value={cwd} onChange={setCwd} trackedRepos={trackedRepos} />
        </Field>
      ) : (
        <McpServersField
          servers={mcpServers}
          onAdd={(server) =>
            setMcpServers((prev) =>
              prev.some((item) => item.name === server.name) ? prev : [...prev, server],
            )
          }
          onRemove={(nameToRemove) =>
            setMcpServers((prev) => prev.filter((server) => server.name !== nameToRemove))
          }
        />
      )}
      <Button
        variant="primary"
        size="md"
        fullWidth
        onClick={() => void submit()}
        disabled={!canSubmit}
      >
        {busy ? "Creating..." : "Create agent"}
      </Button>
    </div>
  );
}

function EditAgentForm({
  agent,
  trackedRepos,
  onSaved,
  onCancel,
  onError,
}: {
  agent: AgentSummary | null;
  trackedRepos: TrackedRepo[];
  onSaved: (agentName: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): JSX.Element | null {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [prompt, setPrompt] = useState(agent?.systemPrompt ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [visibility, setVisibility] = useState<AgentVisibility>(agent?.visibility ?? "private");
  const [cwd, setCwd] = useState(agent?.cwd ?? "");
  const [mcpServers, setMcpServers] = useState<McpServerInput[]>(agent?.mcpServers ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setPrompt(agent?.systemPrompt ?? "");
    setModel(agent?.model ?? "");
    setVisibility(agent?.visibility ?? "private");
    setCwd(agent?.cwd ?? "");
    setMcpServers(agent?.mcpServers ?? []);
  }, [agent]);

  if (!agent) return null;

  const mode = agent.mode ?? "cloud";
  const canSubmit = name.trim() && prompt.trim() && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const updated = await window.chatheads.agents.update(agent.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        systemPrompt: prompt.trim(),
        model: model.trim() || undefined,
        visibility,
        ...(mode === "local" ? { cwd: cwd.trim() || undefined } : { mcpServers }),
      });
      onSaved(updated.name);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface-alt border border-border rounded-xl p-3 mb-3 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div>
          <div className="text-sm font-semibold">Edit agent</div>
          <div className="text-xs text-subtle">
            {mode === "local"
              ? "Updates apply to the next local run."
              : "Updates are saved to Anthropic Managed Agents."}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} className="ml-auto">
          Cancel
        </Button>
      </div>

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary"
        />
      </Field>
      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary"
        />
      </Field>
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base outline-none focus:border-primary resize-none leading-snug"
        />
      </Field>
      <Field label="Model">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={mode === "local" ? DEFAULT_LOCAL_MODEL : DEFAULT_CLOUD_MODEL}
          className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-base font-mono outline-none focus:border-primary"
        />
      </Field>
      <Field label="Visibility">
        <div className="flex gap-1.5">
          <Toggle
            active={visibility === "private"}
            onClick={() => setVisibility("private")}
            title="Sessions stay on your machine."
          >
            Private
          </Toggle>
          <Toggle
            active={visibility === "team"}
            onClick={() => setVisibility("team")}
            title="Teammates see post-session summaries."
          >
            Team
          </Toggle>
        </div>
      </Field>
      {mode === "local" ? (
        <Field label="Working directory">
          <CwdPicker value={cwd} onChange={setCwd} trackedRepos={trackedRepos} />
        </Field>
      ) : (
        <McpServersField
          servers={mcpServers}
          onAdd={(server) =>
            setMcpServers((prev) =>
              prev.some((item) => item.name === server.name) ? prev : [...prev, server],
            )
          }
          onRemove={(nameToRemove) =>
            setMcpServers((prev) => prev.filter((server) => server.name !== nameToRemove))
          }
        />
      )}
      <Button
        variant="primary"
        size="md"
        fullWidth
        onClick={() => void submit()}
        disabled={!canSubmit}
      >
        {busy ? "Saving..." : "Save changes"}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-subtle mb-1">{label}</div>
      {children}
    </div>
  );
}
