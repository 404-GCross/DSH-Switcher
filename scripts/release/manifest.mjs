import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const platforms = { 'linux-x64': ['rpm', 'deb', 'AppImage', 'tar.gz'], 'win-x64': ['zip'], 'mac-x64': ['dmg', 'zip'], 'mac-arm64': ['dmg', 'zip'] }
export async function digest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function writeManifest(directory, platform, metadata) {
  const extensions = platforms[platform]
  if (!extensions) throw new Error('Unsupported platform')
  const filenames = await readdir(directory)
  const files = []
  for (const extension of extensions) {
    const matching = filenames.filter(name => name.startsWith(`DSH-Switcher-${metadata.version}-`) && name.endsWith(`.${extension}`))
    if (matching.length !== 1) throw new Error(`Expected one ${platform} ${extension} artifact; found ${matching.length}`)
    const name = matching[0], filename = path.join(directory, name)
    const info = await stat(filename)
    if (!info.isFile() || !info.size) throw new Error(`Empty or invalid artifact: ${name}`)
    files.push({ name, bytes: info.size, sha256: await digest(filename) })
  }
  const manifest = { ...metadata, platform, files }
  await writeFile(path.join(directory, `manifest-${platform}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Verify every expected platform before any release-writing API call. */
export async function verifyManifests(directory, commit, version) {
  const manifests = [], names = new Set()
  for (const [platform, extensions] of Object.entries(platforms)) {
    const manifest = JSON.parse(await readFile(path.join(directory, `manifest-${platform}.json`), 'utf8'))
    if (manifest.platform !== platform || manifest.commit !== commit || manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length !== extensions.length) {
      throw new Error(`Mismatched release manifest: ${platform}`)
    }
    for (const extension of extensions) {
      if (manifest.files.filter(file => typeof file.name === 'string' && file.name.endsWith(`.${extension}`)).length !== 1) throw new Error(`Missing ${platform} ${extension}`)
    }
    for (const file of manifest.files) {
      if (typeof file.name !== 'string' || !/^DSH-Switcher-[a-zA-Z0-9._-]+$/.test(file.name) || !file.name.startsWith(`DSH-Switcher-${version}-`) || names.has(file.name)) {
        throw new Error('Invalid or duplicate artifact name')
      }
      names.add(file.name)
      const filename = path.join(directory, file.name)
      const info = await stat(filename)
      if (!info.isFile() || info.size !== file.bytes || await digest(filename) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.name}`)
    }
    manifests.push(manifest)
  }
  return manifests
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const metadata = JSON.parse(await readFile('release/build-metadata.json', 'utf8'))
  const manifest = await writeManifest('release', process.argv[2], metadata)
  console.log(`Verified ${manifest.platform}: ${manifest.files.map(file => file.name).join(', ')}`)
}
