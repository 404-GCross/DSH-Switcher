import { build as bundle } from 'esbuild'
import { build as vite } from 'vite'
import { pathToFileURL } from 'node:url'

export async function buildMain() {
  await bundle({
    entryPoints: { index: 'src/main/index.ts', preload: 'src/main/preload.ts', supervisor: 'src/main/local-runtime/supervisor.mjs' },
    outdir: 'dist/main', outExtension: { '.js': '.cjs' }, bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
    sourcemap: true,
  })
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await Promise.all([buildMain(), vite()])
}
