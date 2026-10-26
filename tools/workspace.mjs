// Keep the download tools aligned with candle_viewer.workspace.default_workspace.
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultWorkspace() {
  const configured = process.env.CANDLE_WORKSPACE;
  if (configured) {
    if (configured === '~') return os.homedir();
    if (/^~[\\/]/.test(configured)) return path.join(os.homedir(), configured.slice(2));
    return configured;
  }
  const shared = process.platform === 'win32' ? 'F:/candle_workspace' : '/mnt/desktop-f/candle_workspace';
  if (statSync(shared, { throwIfNoEntry: false })?.isDirectory()) return shared;
  return path.join(os.homedir(), 'candle_workspace');
}
