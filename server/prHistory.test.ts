import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PrHistory, prUrls, createsPr, sessionLineage, ownsPr } from './prHistory.ts';
import { aggregateCi } from './prSummary.ts';
import { prBadge } from './git.ts';
const url = 'https://github.com/acme/app/pull/12';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions(id TEXT, parent_session_id TEXT, model_config TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT);`);
  const add = (id:string, parent:string|null, config:object={}) => db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(id,parent,JSON.stringify(config));
  add('root',null); add('continuation','root'); add('worker',null,{_delegate_from:'root'}); add('nested',null,{_delegate_from:'worker'}); add('worker-cont','worker'); add('branch','root',{_branched_from:'root'}); add('other',null);
  return db;
}
test('PR URL extraction deduplicates and ignores issues and zero', () => {
  assert.deepEqual(prUrls(`${url}#review ${url}/files https://github.com/acme/app/issues/12 https://github.com/acme/app/pull/0`).map(r=>r.url),[url]);
});
test('create commands include CLI, API (flag before endpoint), and MCP; views do not', () => {
  for (const cmd of ['gh pr create --title fix','gh api -X POST repos/acme/app/pulls','gh api repos/acme/app/pulls -f title=fix','mcp__github__create_pull_request']) assert.ok(createsPr(cmd),cmd);
  assert.ok(!createsPr('gh pr view 12')); assert.ok(!createsPr('gh api repos/acme/app/pulls'));
});
test('lineage includes continuations, descendants and ancestors but excludes branched chats', () => {
  const db=fixture(); try { assert.deepEqual(sessionLineage(db,'continuation').sort(),['continuation','nested','root','worker','worker-cont']); } finally {db.close();}
});
test('incremental scan correlates tool calls across ticks; prose and failed calls are not provenance', () => {
  const db=fixture(), h=new PrHistory();
  const msg=(s:string,role:string,content:string,calls:any=null,call:string|null=null)=>db.prepare('INSERT INTO messages(session_id,role,content,tool_calls,tool_call_id) VALUES(?,?,?,?,?)').run(s,role,content,calls&&JSON.stringify(calls),call);
  try {
    msg('root','user',url); msg('root','assistant',url);
    msg('nested','assistant','',[{id:'create',function:{name:'terminal',arguments:JSON.stringify({command:'gh pr create'})}}]);
    assert.equal(h.scan(db,'root').refs.length,0); assert.equal(h.scan(db,'root').scanned,0);
    msg('nested','tool',url,null,'create');
    let s=h.scan(db,'continuation'); assert.equal(s.scanned,1); assert.equal(s.refs[0].created,true);
    msg('worker','assistant','',[{id:'read',function:{name:'terminal',arguments:'gh pr view 13'}}]);
    msg('worker','tool',url.replace('/12','/13'),null,'read');
    msg('worker','assistant','',[{id:'fail',function:{name:'terminal',arguments:'gh pr create'}}]);
    msg('worker','tool',JSON.stringify({exit_code:1,output:url.replace('/12','/14')}),null,'fail');
    s=h.scan(db,'root'); assert.equal(s.refs.length,2); const mentioned=s.refs.find(r=>r.number===13)!;
    assert.equal(mentioned.created,false); assert.equal(ownsPr(mentioned,'someone','me'),false); assert.equal(ownsPr(mentioned,'me','me'),true);
    assert.equal(ownsPr(s.refs.find(r=>r.number===12)!,undefined,undefined),true); assert.equal(h.scan(db,'root').scanned,0);
  } finally {db.close();}
});
test('aggregate CI: failing > pending > passing, closed/merged muted', () => {
  const badge=(state:string,ci:'pass'|'fail'|'pending')=>({...prBadge({number:1,url,state}),ci});
  assert.equal(aggregateCi([badge('OPEN','pass'),badge('OPEN','pending'),badge('OPEN','fail')]),'fail');
  assert.equal(aggregateCi([badge('MERGED','fail'),badge('OPEN','pending')]),'pending');
  assert.equal(aggregateCi([badge('CLOSED','fail'),badge('OPEN','pass')]),'pass');
  assert.equal(aggregateCi([badge('MERGED','pass')]),null);
});
