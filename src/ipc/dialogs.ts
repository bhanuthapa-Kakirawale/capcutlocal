import { open, save } from '@tauri-apps/plugin-dialog';

const PROJECT_FILTER = { name: 'Kriti Project', extensions: ['kriti'] };

/** Native "Open Project" dialog. Resolves to `null` if the user cancels. */
export async function pickProjectToOpen(): Promise<string | null> {
  const result = await open({ multiple: false, directory: false, filters: [PROJECT_FILTER] });
  return typeof result === 'string' ? result : null;
}

/** Native "Save As" dialog. Resolves to `null` if the user cancels. */
export async function pickProjectSaveLocation(defaultFileName: string): Promise<string | null> {
  const result = await save({ defaultPath: `${defaultFileName}.kriti`, filters: [PROJECT_FILTER] });
  return result ?? null;
}
