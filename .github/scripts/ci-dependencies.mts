import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Test the exact unpublished dependencies checked out by this workflow.
const harmony = join(process.env.RUNNER_TEMP, 'dsh-harmony-0.8.12.tgz').replaceAll('\\', '/')
const binding = join(process.env.RUNNER_TEMP, 'the-binding-of-dsh-0.1.8.tgz').replaceAll('\\', '/')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
manifest.dependencies['dsh-harmony'] = `file:${harmony}`
manifest.dependencies['the-binding-of-dsh'] = `file:${binding}`
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n')
appendFileSync(process.env.GITHUB_ENV, [
  `DSH_HARMONY_PACKAGE_SPEC=${harmony}`,
  `DSH_BINDING_PACKAGE_SPEC=${binding}`,
  `DSH_HARMONY_BIN_ENTRY=${resolve('.ci/harmony/lib/bin.js')}`,
  `DSH_UPSTREAM_ENTRY=${join(process.env.RUNNER_TEMP, 'upstream/node_modules/@deepseek-ai/dsh/lib/bin.js')}`,
].join('\n') + '\n')
