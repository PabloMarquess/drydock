import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const { plugins } = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'))
const listed = plugins.map((p) => p.source).filter((s) => typeof s === 'string')
const found = existsSync('plugins') ? readdirSync('plugins').map((d) => `./plugins/${d}`) : []
const runs = [['claude', 'plugin', 'validate', '.']]

for (const dir of new Set([...listed, ...found])) {
  runs.push(['claude', 'plugin', 'validate', dir])
  if (!existsSync(dir)) continue
  if (readdirSync(dir, { recursive: true }).some((f) => /\.test\.tsx?$/.test(f))) {
    runs.push(['claude', 'plugin', 'test', dir])
  }
  if (existsSync(`${dir}/.claude-plugin/types`)) runs.push(['tsc', '-p', dir])
}

for (const [cmd, ...args] of runs) {
  if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) process.exitCode = 1
}
