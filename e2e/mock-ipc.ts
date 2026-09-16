import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';

/*
 * Browser + mock-IPC test backend (ADR-014, docs/ROADMAP.md Phase 4 gate): serves the
 * real app (via the second <script> tag in mock-app.html) against a real Chromium tab,
 * but every Tauri command is answered here instead of by the Rust core. This is the
 * fast, no-Rust-build path for UI flow tests; e2e/app-smoke.spec.ts (CDP-attached to the
 * real built app) is the other half of the dual-mode strategy.
 */

mockWindows('main');
mockConvertFileSrc('windows');

const importedVideoOutcome = {
  status: 'imported',
  path: 'C:\\Media\\clip.mp4',
  kind: 'video',
  suggestedName: 'clip',
  fingerprint: { sizeBytes: 1_000_000, modifiedMs: 1_757_800_000_000, sampleHash: '3fa2b1c0' },
  info: {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationFlicks: 705_600_000 * 4,
    sizeBytes: 1_000_000,
    bitRate: 5_000_000,
    video: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'High',
      width: 1920,
      height: 1080,
      sampleAspectRatio: { num: 1, den: 1 },
      rotation: 0,
      frameRate: { num: 30, den: 1 },
      avgFrameRate: { num: 30, den: 1 },
      isVariableFrameRate: false,
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
      isHdr: false,
      hasAlpha: false,
      startOffsetFlicks: 0,
      durationFlicks: 705_600_000 * 4,
    },
    audio: [
      {
        streamIndex: 1,
        codec: 'aac',
        sampleRate: 48000,
        channels: 2,
        channelLayout: 'stereo',
        language: null,
        startOffsetFlicks: 0,
        durationFlicks: 705_600_000 * 4,
      },
    ],
    image: null,
    probedWith: 'ffprobe-test',
  },
};

mockIPC(
  (cmd) => {
    switch (cmd) {
      case 'app_info':
        return {
          name: 'Kriti',
          version: '0.1.0',
          tauriVersion: '2.11.0',
          os: 'windows',
          arch: 'x86_64',
          debugBuild: false,
          logDir: 'C:\\Users\\example\\AppData\\Local\\com.kriti.studio\\logs',
        };
      case 'session_check_recovery':
        return null;
      case 'recent_projects_list':
        return [];
      case 'session_set_active_project':
      case 'log_write':
        return null;
      case 'plugin:dialog|open':
        return ['C:\\Media\\clip.mp4'];
      case 'media_import':
        return [importedVideoOutcome];
      case 'media_generate_poster':
        return 'C:\\Media\\poster.png';
      default:
        console.warn(`[mock-ipc] unmocked command: ${cmd}`);
        return null;
    }
  },
  { shouldMockEvents: true },
);
