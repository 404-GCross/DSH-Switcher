/** One monotonically increasing prerelease version shared by every matrix job. */
export function developmentVersion(base, run, attempt) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base)
  if (!match || !/^[1-9]\d*$/.test(run ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')) {
    throw new Error('Expected a stable base version and positive GitHub run/attempt numbers')
  }
  return `${base}-dev.${run}.${attempt}`
}
