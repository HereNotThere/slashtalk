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
        const candidates = localRepos.list();
        if (candidates.length === 0) {
          return {
            kind: "error",
            message:
              "No local repos tracked. Add one from the tray menu so the agent has somewhere to look.",
          };
        }
        return { kind: "needs-repo", candidates };
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
      } else if (result.errorMessage) {
        // No answer + a captured SDK error → surface the real reason instead
        // of falling through to the renderer's generic "empty answer" string.
        // Most often this is a spawn/PATH/auth failure visible only in the
        // installed .app (Finder-launched env doesn't inherit the shell).
        return { kind: "error", message: result.errorMessage };
      }

      return {
        kind: "ok",
        text: result.text,
        hadError: result.hadError,
        ghAvailable: result.ghAvailable,
      };
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
