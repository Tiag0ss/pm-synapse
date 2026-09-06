/**
 * Copy Excalidraw font assets into public/ so the app does not fetch them from esm.sh.
 * Skips the large Xiaolai CJK set (~13MB) unless COPY_EXCALIDRAW_XIAOLAI=1.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const src = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const dest = join(root, 'public/excalidraw/fonts');

if (!existsSync(src)) {
  console.warn('[copy-excalidraw-assets] Fonts not found (is @excalidraw/excalidraw installed?)');
  process.exit(0);
}

mkdirSync(join(root, 'public/excalidraw'), { recursive: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const includeXiaolai = process.env.COPY_EXCALIDRAW_XIAOLAI === '1';
cpSync(src, dest, {
  recursive: true,
  filter: (path) => {
    if (includeXiaolai) return true;
    return !path.includes(`${join('fonts', 'Xiaolai')}`) && !path.endsWith('Xiaolai');
  },
});

console.log(
  `[copy-excalidraw-assets] Copied fonts → public/excalidraw/fonts${
    includeXiaolai ? '' : ' (Xiaolai skipped)'
  }`
);
