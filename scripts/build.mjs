import { build as bundle } from 'esbuild'
import { build as vite } from 'vite'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'

export async function buildMain() {
  await bundle({
    entryPoints: ['src/main/index.ts', 'src/main/preload.ts'],
    outdir: 'dist/main', outExtension: { '.js': '.cjs' }, bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
    sourcemap: true,
  })
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const svg = await readFile('build/icon.svg', 'utf8')
  await writeFile('build/icon.png', new Resvg(svg).render().asPng())
  await Promise.all([buildMain(), vite()])
}
