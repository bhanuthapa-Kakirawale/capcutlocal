import { useCallback, useEffect, useState } from 'react';
import { recentProjectsList } from '../ipc/commands';
import type { RecentProject } from '../ipc/contracts';
import { describeIpcError } from '../ipc/invoke';
import { logger } from './logger';

export function useRecentProjects(): { recents: RecentProject[]; refresh: () => void } {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    void recentProjectsList().then((result) => {
      if (!active) return;
      if (result.ok) {
        setRecents(result.value);
      } else {
        logger.warn(`recent_projects_list failed: ${describeIpcError(result.error)}`);
      }
    });
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { recents, refresh };
}
