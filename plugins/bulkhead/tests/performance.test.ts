import { describe, expect, test } from 'claude-code/testing'

import { verdict } from './support'

const kb = (s: string): string => `${(s.length / 1000).toFixed(1)} KB`

const ms = (command: string): number => {
  const t = performance.now()
  verdict(command)
  return performance.now() - t
}

const UNITS = [
  'terraform apply ',
  'kubectl scale ',
  'kubectl replace ',
  'aws s3 rb ',
  'aws s3 sync ',
  'git push ',
  'git reset git branch git clean ',
  'terraform apply kubectl scale aws s3 rb git push helm ',
  'kubectl delete -x ',
  'aws iam put-aaaa-',
  'git clean -aaaa ',
  'aws stop-',
  'rm -rf dist/x ',
  'kubectl delete --all-x ',
  'helm ',
]

describe('200 KB of one repeated phrase stays under 1000 ms', () => {
  for (const unit of UNITS) {
    const command = unit.repeat(Math.ceil(200_000 / unit.length))
    test(`${kb(command)} of "${unit.trim()}"`, () => {
      expect(ms(command)).toBeLessThan(1000)
    })
  }
})

const LONG: [string, string][] = [
  ['git with 3000 -c flags', `git${' -c a'.repeat(3000)} x`],
  ['kubectl with 3000 -n flags', `kubectl${' -n a'.repeat(3000)} get`],
  ['aws with 3000 valued flags', `aws${' --a b'.repeat(3000)} ec2 describe`],
  ['echo with 5000 quoted words', `echo ${'"a" '.repeat(5000)}`],
  ['terraform with 3000 destroy.x words', `terraform${' destroy.x'.repeat(3000)}`],
  ['kubectl get with 200 label and namespace flags', `kubectl get pods${' -l a=b -n x'.repeat(200)} | grep x`],
]

describe('long commands of repeated words stay under 200 ms', () => {
  for (const [name, command] of LONG)
    test(`${kb(command)}: ${name}`, () => {
      expect(ms(command)).toBeLessThan(200)
    })
})

test('a 21.9 KB one-line JSON echo stays under 1000 ms', () => {
  const body = Array.from({ length: 500 }, (_, i) => `{"step":${i},"run":"git push","to":"origin"}`).join(',')
  const command = `echo '[${body}]' > plan.json`
  expect(kb(command)).toBe('21.9 KB')
  expect(ms(command)).toBeLessThan(1000)
})
