import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCi, overviewCollapsed, overviewMode, overviewSummary, stackRows } from './prOverview.ts';
import type { PrBadge } from './api.ts';
const pr = (state: PrBadge['state'], ci: PrBadge['ci']): PrBadge => ({ number:1,url:'https://github.com/example/project/pull/1',title:'Example',headRefName:'feature',additions:3,deletions:1,state,ci });
test('overview aggregates active CI, never stale merged or closed checks', () => {
  const prs = [pr('draft','pass'),pr('open','pending'),pr('merged','fail'),pr('closed','fail')];
  assert.equal(aggregateCi(prs),'pending');
  assert.equal(overviewSummary(prs),'1 draft · 1 open · 1 merged · 1 closed · CI 1 passing, 1 pending');
  assert.equal(aggregateCi([...prs,pr('draft','fail')]),'fail');
  assert.equal(aggregateCi([pr('open','pass')]),'pass');
  assert.equal(aggregateCi([pr('merged','pass')]),null);
  assert.equal(overviewSummary([]),'');
});
test('card needs a safe gutter, any panel forces the pill', () => {
  assert.equal(overviewMode(1416,false),'card');
  assert.equal(overviewMode(1415,false),'pill');
  assert.equal(overviewMode(1920,true),'pill');
  assert.equal(overviewMode(1100,false),'pill');
  assert.equal(overviewMode(390,false),'pill');
});
test('only the explicit stored collapse value collapses', () => {
  assert.equal(overviewCollapsed('1'),true);
  for (const value of [null,'0','','true','bad']) assert.equal(overviewCollapsed(value),false);
});

test('stackRows nests PRs based on another PR branch, same repo only, cycles flattened', () => {
  const pr = (number: number, head: string, base: string, repo = 'o/r') => ({ number, url: `https://github.com/${repo}/pull/${number}`, headRefName: head, baseRefName: base, state: 'open' as const, ci: null, additions: 0, deletions: 0 });
  const a = pr(3, 'top', 'mid'), b = pr(2, 'mid', 'bottom'), c = pr(1, 'bottom', 'main'), d = pr(4, 'other', 'main'), e = pr(5, 'x', 'bottom', 'o/elsewhere');
  assert.deepEqual(stackRows([a, b, c, d, e]).map(r => [r.pr.number, r.depth]), [[1, 0], [2, 1], [3, 2], [4, 0], [5, 0]]);
  const x = pr(6, 'p', 'q'), y = pr(7, 'q', 'p');
  assert.deepEqual(stackRows([x, y]).map(r => [r.pr.number, r.depth]), [[6, 0], [7, 0]]);
});
