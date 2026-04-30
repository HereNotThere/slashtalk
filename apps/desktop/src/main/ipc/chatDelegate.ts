import { ipcMain } from "electron";
import * as backend from "../backend";
import * as localRepos from "../localRepos";
import { collectChatWorkSnapshot } from "../chatWorkSnapshot";
import { broadcast, liveWindows } from "../windows/broadcast";
import type {
  ChatDelegateEvent,
  DelegatedChatRequest,
  DelegatedChatResponse,
  TrackedRepo,
} from "../../shared/types";

const CHANNEL_REQUEST = "chat:run-delegated";
const CHANNEL_EVENT = "chat:delegated-event";

export function registerChatDelegateIpc(
  getResponseWindow: () => Electron.BrowserWindow | null,
): void {
  ipcMain.handle(
    CHANNEL_REQUEST,
    async (_e, raw: DelegatedChatRequest): Promise<DelegatedChatResponse> => {
      const task = (raw?.task ?? "").trim();
      if (!task) return { kind: "error", message: "empty task" };

      const repo = resolveRepo(raw);
      if (!repo) {
        const candidates = localRepos.list();
        if (candidates.length === 0) {
          return {
            kind: "error",
            message:
              "No local repos tracked. Add one from the tray menu so Slashtalk can summarize it.",
          };
        }
        return { kind: "needs-repo", candidates };
      }

      const onEvent = (event: ChatDelegateEvent): void => {
        broadcast(CHANNEL_EVENT, event, ...liveWindows(getResponseWindow()));
      };

      onEvent({ kind: "phase", label: "Collecting repo snapshot…" });
      const snapshot = await collectChatWorkSnapshot(repo);

      onEvent({ kind: "phase", label: "Asking Slashtalk…" });
      const result = await backend.answerDelegatedWork({
        threadId: raw.threadId,
        body: {
          messageId: raw.messageId,
          task,
          repoFullName: repo.fullName,
          snapshot,
        },
      });

      return {
        kind: "ok",
        text: result.text,
        hadError: result.hadError || (snapshot.collectionErrors?.length ?? 0) > 0,
        ghAvailable: snapshot.ghStatus === "ready",
      };
    },
  );
}

function resolveRepo(req: DelegatedChatRequest): TrackedRepo | null {
  if (typeof req.resolvedRepoId === "number") {
    const match = localRepos.list().find((r) => r.repoId === req.resolvedRepoId);
    return match ?? null;
  }
  if (req.repoFullName) {
    const match = localRepos.findByFullName(req.repoFullName);
    if (match) return match;
  }
  // Single-repo shortcut: if the user only has one tracked repo, use it
  // without prompting. Two or more → ambiguous, ask the renderer to pick.
  const all = localRepos.list();
  if (all.length === 1) return all[0];
  return null;
}
