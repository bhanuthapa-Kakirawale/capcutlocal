import { create } from 'zustand';

/**
 * Where the open project is saved on disk — app/session state, not part of the document
 * (a `.kriti` file does not store its own path). Null means never saved.
 */
export type SessionStore = {
  projectPath: string | null;
  setProjectPath(path: string | null): void;
};

export const useSessionStore = create<SessionStore>((set) => ({
  projectPath: null,
  setProjectPath: (path) => {
    set({ projectPath: path });
  },
}));
