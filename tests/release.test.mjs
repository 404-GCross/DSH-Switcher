import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { developmentVersion } from '../scripts/release/version.mjs'
import { platforms, writeManifest, verifyManifests } from '../scripts/release/manifest.mjs'

const sha = 'a'.repeat(40)
const version = '0.1.0-dev.42.1'
async function fixture(run) {
  const directory = await mkdtemp(path.join(process.env.SWITCHER_TEST_TMP ?? os.tmpdir(), 'switcher-release-'))
  try {
    for (const [platform, extensions] of Object.entries(platforms)) {
      for (const extension of extensions) await writeFile(path.join(directory, `DSH-Switcher-${version}-${platform}.${extension}`), `${platform}/${extension}`)
      // Each build job sees only its own artifacts.
      const job = path.join(directory, platform)
      const { mkdir, copyFile } = await import('node:fs/promises')
      await mkdir(job)
      for (const extension of extensions) {
        const name = `DSH-Switcher-${version}-${platform}.${extension}`
        await copyFile(path.join(directory, name), path.join(job, name))
      }
      await writeManifest(job, platform, { version, commit: sha })
      await copyFile(path.join(job, `manifest-${platform}.json`), path.join(directory, `manifest-${platform}.json`))
    }
    await run(directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('development builds distinguish workflow attempts and reject an already-stamped base', () => {
  assert.equal(developmentVersion('0.1.0', '42', '2'), '0.1.0-dev.42.2')
  assert.throws(() => developmentVersion('0.1.0-dev.42.1', '42', '2'))
  assert.throws(() => developmentVersion('0.1.0', '0', '1'))
})
test('a complete, matching four-platform release can be published', () => fixture(async directory => {
  const manifests = await verifyManifests(directory, sha, version)
  assert.equal(manifests.flatMap(item => item.files).length, 7)
}))
test('an artifact modified after hashing cannot be published', () => fixture(async directory => {
  await writeFile(path.join(directory, `DSH-Switcher-${version}-linux-x64.rpm`), 'corrupted package')
  await assert.rejects(verifyManifests(directory, sha, version), /checksum/)
}))
test('a missing platform or a manifest from another commit blocks publication', () => fixture(async directory => {
  const filename = path.join(directory, 'manifest-mac-arm64.json')
  const manifest = JSON.parse(await readFile(filename, 'utf8'))
  manifest.commit = 'b'.repeat(40)
  await writeFile(filename, JSON.stringify(manifest))
  await assert.rejects(verifyManifests(directory, sha, version), /Mismatched/)
  await rm(filename)
  await assert.rejects(verifyManifests(directory, sha, version), /ENOENT/)
}))
