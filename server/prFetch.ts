// GraphQL variables and execFile argument arrays keep transcript strings out of the shell.
import { run, prBadge, type PrBadge } from './git.ts';
import type { PrRef } from './prHistory.ts';
export async function fetchPrs(refs: PrRef[], cwd: string): Promise<Map<string, PrBadge>> {
  const groups = new Map<string, PrRef[]>(), result = new Map<string, PrBadge>();
  for (const r of refs) { const key = `${r.owner}/${r.repo}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  await Promise.all([...groups.values()].map(async rs => {
    for (let i = 0; i < rs.length; i += 40) {
      const batch = rs.slice(i, i + 40);
      const fields = batch.map((r, n) => `p${n}:pullRequest(number:${r.number}){number url title state isDraft headRefName additions deletions author{login} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{status conclusion} ... on StatusContext{state}}}}}}}}`).join(' ');
      const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fields}}}`;
      const out = JSON.parse(await run('gh', ['api', 'graphql', '--input', '-'], cwd, JSON.stringify({query, variables:{owner:rs[0].owner, repo:rs[0].repo}})));
      batch.forEach((r, n) => { const j = out.data?.repository?.[`p${n}`]; if (j) result.set(r.url, prBadge({...j, statusCheckRollup:j.commits?.nodes?.[0]?.commit?.statusCheckRollup})); });
    }
  }));
  return result;
}
