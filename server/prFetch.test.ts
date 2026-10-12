import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrs } from './prFetch.ts';
import type { PrRef } from './prHistory.ts';
test('GraphQL batches by repository, uses variables, and keeps good aliases/repos on partial errors', async () => {
  const refs: PrRef[] = Array.from({length:45},(_,i)=>({owner:'acme',repo:'app',number:i+1,url:`https://github.com/acme/app/pull/${i+1}`,created:true}));
  refs.push({owner:'missing',repo:'repo',number:1,url:'https://github.com/missing/repo/pull/1',created:true});
  const calls:any[]=[];
  const result=await fetchPrs(refs,'.',async (_,payload:any)=>{
    calls.push(payload); if(payload.variables.owner==='missing')throw new Error('not accessible');
    const repository:any={};
    for(const m of payload.query.matchAll(/p(\d+):pullRequest\(number:(\d+)\)/g)) {
      if(Number(m[2])===3)continue;
      repository[`p${m[1]}`]={number:Number(m[2]),url:`https://github.com/acme/app/pull/${m[2]}`,title:'Fix',state:'OPEN',headRefName:'fix',author:{login:'agent'},commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:[{status:'COMPLETED',conclusion:'FAILURE'}]}}}}]}};
    }
    return {data:{repository},errors:[{message:'PR 3 missing'}]};
  });
  assert.equal(calls.length,3); assert.equal(result.size,44); assert.equal(result.get(refs[0].url)?.ci,'fail');
  assert.equal(result.get(refs[0].url)?.author,'agent'); assert.equal(result.get(refs[0].url)?.headRefName,'fix');
  assert.ok(!calls[0].query.includes('acme')); assert.deepEqual(calls[0].variables,{owner:'acme',repo:'app'});
});
