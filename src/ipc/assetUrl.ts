import { convertFileSrc } from '@tauri-apps/api/core';

/** Turns an absolute file path (e.g. from `media_generate_poster`) into a URL the WebView
 * can load, via the asset protocol (scoped to the cache directory — see tauri.conf.json). */
export function toAssetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}
