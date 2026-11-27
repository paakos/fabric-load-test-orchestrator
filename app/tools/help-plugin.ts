import type { Plugin } from 'vite';
import { join } from 'node:path';
import { buildHelpBundle, defaultRepoRoot, NOTEBOOK } from './helpbuild.ts';

const ID = 'virtual:help';
const RESOLVED = `\0${ID}`;

/**
 * Virtual module `virtual:help`: the help documents and the per-query texts, generated from the repository at build time.
 * Environment variable LOADTEST_REPO_ROOT overrides the repository root (default: the parent folder of the app).
 */
export function helpPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'loadtest-help',
    configResolved(config) { root = config.root; },
    resolveId(id) { return id === ID ? RESOLVED : undefined; },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const repoRoot = defaultRepoRoot(root);
      const bundle = buildHelpBundle(repoRoot, root);
      for (const d of bundle.docs) this.addWatchFile(join(repoRoot, ...d.file.split('/')));
      this.addWatchFile(join(repoRoot, ...NOTEBOOK.split('/')));
      return `export default ${JSON.stringify(bundle)};`;
    },
  };
}
