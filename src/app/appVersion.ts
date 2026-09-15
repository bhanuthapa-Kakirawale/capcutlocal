import { appInfo } from '../ipc/commands';

let cached: string | null = null;

/** The `savedBy` string written into project files (docs/PROJECT-MODEL.md §5.1). Cached
 * after the first successful `app_info` call. */
export async function savedByLabel(): Promise<string> {
  if (cached) return cached;
  const info = await appInfo();
  cached = info.ok ? `Kriti ${info.value.version}` : 'Kriti';
  return cached;
}
