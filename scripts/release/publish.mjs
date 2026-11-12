import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyManifests } from './manifest.mjs'
import { developmentVersion } from './version.mjs'

const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GH_TOKEN: token } = process.env
if (!repo || !token || !/^[0-9a-f]{40}$/.test(sha ?? '') || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publication requires the main branch and a GitHub token')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = developmentVersion(pkg.version, process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT)
const directory = path.resolve(process.argv[2] ?? 'artifacts')
const manifests = await verifyManifests(directory, sha, version)
const files = manifests.flatMap(manifest => manifest.files).sort((a, b) => a.name.localeCompare(b.name))

async function api(route, method = 'GET', body, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

if ((await api('git/ref/heads/main')).object.sha !== sha) {
  console.log('Skipped: a newer main commit exists; the previous dev release is unchanged')
  process.exit(0)
}
const old = await api('releases/tags/dev', 'GET', undefined, true)
if (old && !old.prerelease) throw new Error('Refusing to replace a non-prerelease dev release')
const checksumsName = `SHA256SUMS-${version}.txt`
const metadataName = `build-manifest-${version}.json`
await writeFile(path.join(directory, checksumsName), `${files.map(file => `${file.sha256}  ${file.name}`).join('\n')}\n`)
await writeFile(path.join(directory, metadataName), `${JSON.stringify({ version, commit: sha, platforms: manifests }, null, 2)}\n`)
const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
const body = `自动开发版（Pre-release）\n\n- 版本：\`${version}\`\n- 源码：[\`${sha.slice(0, 12)}\`](https://github.com/${repo}/commit/${sha})\n- [检查与构建记录](${runUrl})\n\n## 下载\n\n- Fedora x86_64：RPM\n- Debian / Ubuntu / Linux Mint x86_64：DEB\n- Arch / Manjaro 及其他 glibc Linux x86_64：AppImage 或 tar.gz\n- Windows x64：ZIP\n- macOS Apple Silicon：arm64 DMG / ZIP\n- macOS Intel：x64 DMG / ZIP\n\nFedora 使用 \`sudo dnf install ./DSH-Switcher-*.rpm\`；Debian / Ubuntu 使用 \`sudo apt install ./DSH-Switcher-*.deb\`。AppImage 赋予执行权限后运行；无 FUSE 时可加 \`--appimage-extract-and-run\`。校验文件：\`${checksumsName}\`。\n\nCI 覆盖 Fedora 44 RPM、Debian 12/13 与 Ubuntu 22.04/24.04 DEB，以及 Ubuntu、Arch 的 AppImage 启动。Mint / Manjaro 沿用上游兼容方式，未单独运行发行版测试。\n\nWindows 未签名；macOS 使用临时签名，未公证。固定 \`dev\` 标签随通过全部检查的 main 构建更新。`
let release = old
if (!release) {
  const ref = await api('git/ref/tags/dev', 'GET', undefined, true)
  if (!ref) await api('git/refs', 'POST', { ref: 'refs/tags/dev', sha })
  release = await api('releases', 'POST', { tag_name: 'dev', target_commitish: sha, name: `Development build · ${version}`, draft: true, prerelease: true, make_latest: 'false', body })
}
// Versioned asset names keep the previous build available if any upload fails.
const assetNames = [...files.map(file => file.name), checksumsName, metadataName]
execFileSync('gh', ['release', 'upload', 'dev', ...assetNames.map(name => path.join(directory, name)), '--repo', repo, '--clobber'], { stdio: 'inherit' })
if ((await api('git/ref/heads/main')).object.sha !== sha) {
  console.log('A newer main commit arrived during upload; no tag or public release metadata was changed')
  process.exit(0)
}
await api('git/refs/tags/dev', 'PATCH', { sha, force: true })
await api(`releases/${release.id}`, 'PATCH', { name: `Development build · ${version}`, body, draft: false, prerelease: true, make_latest: 'false' })
// Only prune old binaries after the complete new set and release metadata are published.
let page = 1, assets = []
while (true) {
  const batch = await api(`releases/${release.id}/assets?per_page=100&page=${page++}`)
  assets.push(...batch)
  if (batch.length < 100) break
}
for (const asset of assets) {
  if (/^(DSH-Switcher-|SHA256SUMS-|build-manifest-)/.test(asset.name) && !assetNames.includes(asset.name)) await api(`releases/assets/${asset.id}`, 'DELETE')
}
console.log(`Published https://github.com/${repo}/releases/tag/dev (${sha.slice(0, 12)})`)
