import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCi, overviewCollapsed, overviewMode, overviewSummary } from './prOverview.ts';
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
  assert.equal(overviewMode(1336,false),'card');
  assert.equal(overviewMode(1335,false),'pill');
  assert.equal(overviewMode(1920,true),'pill');
  assert.equal(overviewMode(1100,false),'pill');
  assert.equal(overviewMode(390,false),'pill');
});
test('only the explicit stored collapse value collapses', () => {
  assert.equal(overviewCollapsed('1'),true);
  for (const value of [null,'0','','true','bad']) assert.equal(overviewCollapsed(value),false);
});
