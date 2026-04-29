import { ipcMain } from "electron";
import * as backend from "../backend";
import * as localRepos from "../localRepos";
import { runDelegatedChat, hasClaudeCli } from "../chatDelegate";
import { broadcast, liveWindows } from "../windows/broadcast";
import type { AgentStreamEvent } from "../anthropic";
import type { DelegatedChatRequest, DelegatedChatResponse } from "../../shared/types";

const CHANNEL_REQUEST = "chat:run-delegated";
const CHANNEL_EVENT = "chat:delegated-event";

const CLAUDE_CLI_INSTALL_HINT =
  "Claude Code CLI isn't installed. Install it from https://claude.com/code, then restart Slashtalk to enable deep-repo questions.";

export function registerChatDelegateIpc(
  getResponseWindow: () => Electron.BrowserWindow | null,
): void {
  ipcMain.handle(
    CHANNEL_REQUEST,
    async (_e, raw: DelegatedChatRequest): Promise<DelegatedChatResponse> => {
      const task = (raw?.task ?? "").trim();
      if (!task) return { kind: "error", message: "empty task" };

      if (!(await hasClaudeCli())) {
        return { kind: "error", message: CLAUDE_CLI_INSTALL_HINT };
      }

      const cwd = resolveCwd(raw);
      if (!cwd) {
        return { kind: "needs-repo", candidates: localRepos.list() };
      }

      const onEvent = (event: AgentStreamEvent): void => {
        broadcast(CHANNEL_EVENT, event, ...liveWindows(getResponseWindow()));
      };

      const result = await runDelegatedChat({ task, cwd, onEvent });

      if (result.text) {
        try {
          await backend.finalizeDelegatedChat({
            threadId: raw.threadId,
            messageId: raw.messageId,
            answer: result.text,
          });
        } catch (err) {
          // Soft-fail per CLAUDE.md: persisting history must not break the
          // user-facing answer (already in `result.text`, returned below).
          console.error("[chat-delegate] finalize failed:", err);
        }
      }

      return { kind: "ok", text: result.text, hadError: result.hadError };
    },
  );
}

function resolveCwd(req: DelegatedChatRequest): string | null {
  if (typeof req.resolvedRepoId === "number") {
    const match = localRepos.list().find((r) => r.repoId === req.resolvedRepoId);
    return match?.localPath ?? null;
  }
  if (req.repoFullName) {
    const match = localRepos.findByFullName(req.repoFullName);
    if (match) return match.localPath;
  }
  // Single-repo shortcut: if the user only has one tracked repo, use it
  // without prompting. Two or more → ambiguous, ask the renderer to pick.
  const all = localRepos.list();
  if (all.length === 1) return all[0].localPath;
  return null;
}
