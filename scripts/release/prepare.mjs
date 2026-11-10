import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { developmentVersion } from './version.mjs'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = developmentVersion(pkg.version, process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT)
if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw new Error('Missing source commit')
pkg.version = version
pkg.build.buildNumber = process.env.GITHUB_RUN_NUMBER
// CFBundleVersion uses a numeric build identifier independent of the displayed prerelease.
pkg.build.buildVersion = process.env.GITHUB_RUN_NUMBER
await writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
lock.version = version
lock.packages[''].version = version
await writeFile('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
await mkdir('release', { recursive: true })
await writeFile('release/build-metadata.json', `${JSON.stringify({
  version, commit: process.env.GITHUB_SHA,
  run: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
}, null, 2)}\n`)
console.log(`Development version: ${version}`)
