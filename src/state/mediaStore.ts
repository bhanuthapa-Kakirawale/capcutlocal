import { create } from 'zustand';

/**
 * Runtime media status, not part of the project document (docs/ARCHITECTURE.md §2.1):
 * poster paths as they're generated, keyed by asset id. Import/job status themselves are
 * observed directly from the IPC calls that drive them, not duplicated into this store.
 */
export type MediaStore = {
  posterPaths: Record<string, string>;
  setPosterPath(assetId: string, path: string): void;
};

export const useMediaStore = create<MediaStore>((set) => ({
  posterPaths: {},
  setPosterPath: (assetId, path) => {
    set((s) => ({ posterPaths: { ...s.posterPaths, [assetId]: path } }));
  },
}));
