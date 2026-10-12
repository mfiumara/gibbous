// GraphQL variables and execFile argument arrays keep transcript strings out of the shell.
import { execFile } from 'node:child_process';
import { prBadge, type PrBadge } from './git.ts';
// gh exits nonzero for a missing alias, even when the other aliases succeeded. Keep partial data.
function graphql(cwd: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = execFile('gh', ['api', 'graphql', '--input', '-'], {cwd, maxBuffer: 16 * 1024 * 1024}, (err, stdout) => {
      try { const j = JSON.parse(stdout); if (j.data) resolve(j); else reject(err ?? new Error('No GraphQL data')); }
      catch { reject(err ?? new Error('Invalid GraphQL response')); }
    });
    p.stdin?.end(JSON.stringify(payload));
  });
}
import type { PrRef } from './prHistory.ts';
export async function fetchPrs(refs: PrRef[], cwd: string, request = graphql): Promise<Map<string, PrBadge>> {
  const groups = new Map<string, PrRef[]>(), result = new Map<string, PrBadge>();
  for (const r of refs) { const key = `${r.owner}/${r.repo}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  await Promise.all([...groups.values()].map(async rs => {
    for (let i = 0; i < rs.length; i += 40) {
      const batch = rs.slice(i, i + 40);
      const fields = batch.map((r, n) => `p${n}:pullRequest(number:${r.number}){number url title state isDraft headRefName baseRefName additions deletions author{login} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}`).join(' ');
      const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fields}}}`;
      const out = await request(cwd, {query, variables:{owner:rs[0].owner, repo:rs[0].repo}}).catch(() => null);
      if (!out) continue;
      batch.forEach((r, n) => { const j = out.data?.repository?.[`p${n}`]; if (j) result.set(r.url, prBadge({...j, statusCheckRollup:j.commits?.nodes?.[0]?.commit?.statusCheckRollup})); });
    }
  }));
  return result;
}
