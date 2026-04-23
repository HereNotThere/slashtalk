import { useEffect, useState } from "react";
import type { ChatHead } from "../../shared/types";

// Subscribes to main-process project-head updates. Project heads are the
// GitHub repos the user has claimed; only the overlay renders them.
export function useProjects(): ChatHead[] {
  const [projects, setProjects] = useState<ChatHead[]>([]);

  useEffect(() => {
    void window.chatheads.listProjects().then(setProjects);
    return window.chatheads.onProjectsUpdate(setProjects);
  }, []);

  return projects;
}
