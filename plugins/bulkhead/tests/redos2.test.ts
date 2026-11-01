import { describe, expect, test } from 'claude-code/testing'
import { judge } from '../hooks/rules'
import { judge as oldJudge } from './rules-old'

const extra = { block: [], confirm: [], disabled: new Set<string>() }
const units = [
  'kubectl delete -x ',
  'aws iam put-aaaa-',
  'git clean -aaaa ',
  'aws stop-',
  'rm -rf dist/x ',
  'kubectl delete --all-x ',
  'helm ',
]
describe('more', () => {
  for (const unit of units)
    test(unit, () => {
      const cmd = unit.repeat(Math.ceil(200_000 / unit.length))
      const t = performance.now()
      judge(cmd, '/home/dev/work/infra', '/home/dev/work/infra', '/home/dev', extra)
      expect(performance.now() - t).toBeLessThan(1000)
    })
  test('old: realistic 30 KB one-line json', () => {
    const body = Array.from({ length: 500 }, (_, i) => `{"step":${i},"run":"git push","to":"origin"}`).join(',')
    const cmd = `echo '[${body}]' > plan.json`
    const [old, now] = [oldJudge, judge].map((j) => {
      const t = performance.now()
      j(cmd, '/home/dev/work/infra', '/home/dev/work/infra', '/home/dev', extra)
      return performance.now() - t
    })
    expect(now).toBeLessThan(1000)
    expect(now).toBeLessThan(old ?? 0)
  })
})
