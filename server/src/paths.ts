import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the repo root by walking up for the workspace package.json. Beats
 * counting `..` segments, which differ between the `dist` and `dist-test`
 * builds, and `HUB_ROOT` wins for unusual deployments.
 */
export function findRootDir(startDir?: string): string {
  if (process.env['HUB_ROOT']) return path.resolve(process.env['HUB_ROOT']);

  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { workspaces?: unknown; name?: string };
        if (pkg.workspaces || pkg.name === 'pi-smart-home-hub') return dir;
      } catch {
        // Unreadable package.json: keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function readVersion(rootDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
