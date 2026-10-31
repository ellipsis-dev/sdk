// Assemble the publishable artifact under publish/ — the ONLY directory npm
// ever publishes from (the workspace package.json stays private:true so the
// source tree can never be published by accident).
//
// The staging package.json is derived from the workspace one with the
// publish-only shape: exports repointed at dist/, a strict `files` allowlist,
// no scripts/devDependencies, no `repository` field (private repo, public
// artifact), publishConfig access=public.
//
// Guardrail: the tarball's file list is pinned. `--update-manifest` rewrites
// pack-manifest.txt from a fresh `npm pack --dry-run`; `--check-manifest`
// (CI) fails when the tarball would contain anything the committed manifest
// doesn't expect — a new file sneaking into the published artifact must be an
// explicit, reviewed change. tsup's shared d.ts chunk carries a content hash
// in its filename; the manifest masks it (the guardrail pins WHICH files
// ship, not their contents).

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const publishDir = join(pkgDir, 'publish');
const manifestPath = join(pkgDir, 'pack-manifest.txt');

// --- stage ------------------------------------------------------------------

rmSync(publishDir, { recursive: true, force: true });
mkdirSync(publishDir);
for (const entry of ['dist', 'README.md', 'LICENSE']) {
  cpSync(join(pkgDir, entry), join(publishDir, entry), { recursive: true });
}
// The schema documents are shared across the SDKs and live one level up
// (packages/sdk/schema); they still ship inside the npm tarball.
cpSync(join(pkgDir, '../schema'), join(publishDir, 'schema'), {
  recursive: true,
});

const workspacePkg = JSON.parse(
  readFileSync(join(pkgDir, 'package.json'), 'utf8')
);
const publishPkg = {
  name: workspacePkg.name,
  version: workspacePkg.version,
  description: workspacePkg.description,
  license: workspacePkg.license,
  type: 'module',
  sideEffects: false,
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './stream': {
      types: './dist/stream/index.d.ts',
      import: './dist/stream/index.js',
    },
    './store': {
      types: './dist/store/index.d.ts',
      import: './dist/store/index.js',
    },
  },
  files: ['dist', 'schema'],
  publishConfig: { access: 'public' },
};
writeFileSync(
  join(publishDir, 'package.json'),
  JSON.stringify(publishPkg, null, 2) + '\n'
);

// --- manifest guardrail ------------------------------------------------------

const packJson = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: publishDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
);
// npm <= 11 emits an array of pack results; npm >= 12 emits an object keyed
// by package name. Object.values() yields the single result either way.
const [packResult] = Object.values(packJson);
const manifest =
  packResult.files
    .map((f) => f.path)
    // Mask tsup's content-hashed shared chunks so the committed manifest is
    // stable across code and type changes.
    .map((p) => p.replace(/-[A-Za-z0-9_-]{8}\.(d\.ts|js)$/, '-HASH.$1'))
    .sort()
    .join('\n') + '\n';

const mode = process.argv[2];
if (mode === '--update-manifest') {
  writeFileSync(manifestPath, manifest);
  console.log(`Wrote ${manifestPath}`);
} else if (mode === '--check-manifest') {
  const expected = readFileSync(manifestPath, 'utf8');
  if (manifest !== expected) {
    console.error(
      'npm pack manifest drifted from pack-manifest.txt.\n' +
        '--- expected ---\n' +
        expected +
        '--- actual ---\n' +
        manifest +
        'If the change is intentional, run `pnpm prepare:publish --update-manifest` and commit.'
    );
    process.exit(1);
  }
  console.log('pack manifest matches');
} else {
  console.log(manifest.trimEnd());
}
console.log(`Staged publishable package at ${publishDir}`);
