import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, RefreshCw, GitCommitHorizontal, GitPullRequest, GitBranch, ChevronDown, ArrowDownUp, Archive, ArchiveRestore, AlertTriangle, Send, Wand2, CheckCircle2, XCircle, CircleDashed, ExternalLink, Upload } from 'lucide-react';
import { api, type FileChange, type Thread } from '../api';
import { useStore, toastError } from '../store';
import { Button, IconButton, Menu, MenuItem, inputCls } from '../ui';
import { PullRequests } from '../PullRequests';
import { DiffView, type LineComment } from './DiffView';
import type { GitInfo, PrStatus } from '../../../server/git.ts';

interface Changes { repo: boolean; branch?: string; base?: string; files: FileChange[] }
const statusCls: Record<string, string> = { M: 'text-tide', A: 'text-sprout', '?': 'text-sprout', D: 'text-oxide', R: 'text-halo' };
const send = (thread: Thread, text: string) => api.post(`/api/threads/${thread.id}/send`, { text });

function GitBar({ thread, info, reload }: { thread: Thread; info: GitInfo; reload(): void }) {
  const [menu, setMenu] = useState(false);
  const toast = useStore(s => s.toast);
  const act = async (action: string, extra: object = {}) => {
    setMenu(false);
    const r = await api.post<{ ok: boolean; error?: string }>(`/api/threads/${thread.id}/git`, { action, ...extra }).catch(e => { toastError(e); return null; });
    if (r && !r.ok) toast({ title: `git ${action} stopped`, body: r.error, tone: 'error' });
    reload();
  };
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line">
      <div className="relative">
        <button onClick={() => setMenu(!menu)} className="press inline-flex items-center gap-1.5 h-7 px-2 rounded-lg font-mono text-[12px] hover:bg-ridge" aria-expanded={menu}>
          <GitBranch size={12} className="text-ash" /><span className="max-w-48 truncate">{info.branch}</span><ChevronDown size={11} className="text-ash" />
        </button>
        <Menu open={menu} onClose={() => setMenu(false)} align="left" className="w-64 max-h-80 overflow-y-auto">
          <p className="label px-2.5 py-1">Switch branch</p>
          {info.branches.map(b => <MenuItem key={b} icon={b === info.branch ? <CheckCircle2 className="text-tide" /> : <GitBranch />} onClick={() => b !== info.branch && act('switch', { branch: b })}><span className="font-mono text-[12px]">{b}</span></MenuItem>)}
        </Menu>
      </div>
      {info.base && <span className="font-mono text-[11px] text-ash whitespace-nowrap truncate min-w-0" data-tip={`Compared with ${info.base}`}>{info.ahead > 0 && <span className="text-sprout">↑{info.ahead}</span>} {info.behind > 0 && <span className="text-halo">↓{info.behind}</span>}{!info.ahead && !info.behind && `= ${info.base}`}</span>}
      <span className="flex-1" />
      <IconButton label={info.base ? `Rebase onto ${info.base}` : 'Pull and rebase'} onClick={() => act('sync')}><ArrowDownUp size={14} /></IconButton>
      <IconButton label="Stash changes" disabled={!info.dirty} onClick={() => act('stash')}><Archive size={14} /></IconButton>
      {info.stashes > 0 && <IconButton label={`Pop stash (${info.stashes})`} onClick={() => act('unstash')}><ArchiveRestore size={14} /></IconButton>}
      <IconButton label="Refresh" onClick={reload}><RefreshCw size={14} /></IconButton>
    </div>
  );
}

function PrCard({ thread, pr, reload, compact = false }: { thread: Thread; pr: PrStatus; reload(): void; compact?: boolean }) {
  const toast = useStore(s => s.toast);
  const failing = pr.checks.filter(c => /fail|error|cancel|timed/.test(c.state));
  const pending = pr.checks.filter(c => /pending|queue|progress|waiting|expected/.test(c.state));
  const Icon = failing.length ? XCircle : pending.length ? CircleDashed : CheckCircle2;
  return (
    <div className="m-2.5 rounded-xl surface p-3 space-y-2 animate-rise">
      {!compact && <div className="flex items-center gap-2">
        <GitPullRequest size={14} className={pr.state === 'MERGED' ? 'text-[#b8a6e0]' : pr.state === 'CLOSED' ? 'text-oxide' : 'text-sprout'} />
        <a href={pr.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 truncate text-[13px] font-bold hover:underline">#{pr.number} {pr.title}</a>
        <span className="label">{pr.isDraft ? 'draft' : pr.state.toLowerCase()}</span>
        <IconButton label="Open on GitHub" onClick={() => window.open(pr.url, '_blank')}><ExternalLink size={13} /></IconButton>
      </div>}
      <div className="flex items-center gap-2 text-[12.5px]">
        {pr.checks.length > 0 && <Icon size={14} className={failing.length ? 'text-oxide' : pending.length ? 'text-halo animate-spin [animation-duration:3s]' : 'text-sprout'} />}
        <span className="text-dust flex-1">{!pr.checks.length ? 'No CI checks' : failing.length ? `${failing.length} check${failing.length > 1 ? 's' : ''} failing` : pending.length ? `${pending.length} running` : 'All checks passed'}{pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase().replace('_', ' ')}` : ''}</span>
        {failing.length > 0 && <Button size="sm" tone="halo" onClick={() => api.post(`/api/threads/${thread.id}/fix-ci`).then(() => toast({ title: 'Sent the failing logs to the agent' }), toastError)}><Wand2 size={12} />Fix CI</Button>}
        <Button size="sm" onClick={() => api.post(`/api/threads/${thread.id}/git`, { action: 'push' }).then(() => { toast({ title: 'Pushed' }); reload(); }, toastError)}><Upload size={12} />Push</Button>
      </div>
      {failing.length > 0 && <ul className="space-y-0.5 text-[12px]">{failing.slice(0, 5).map(c => <li key={c.name}><a href={c.url} target="_blank" rel="noreferrer" className="text-oxide hover:underline">✗ {c.name}</a></li>)}</ul>}
    </div>
  );
}

export function ChangesPanel({ thread, refreshKey }: { thread: Thread; refreshKey: number }) {
  const [data, setData] = useState<Changes>();
  const linkedPrs = useStore(s => s.threadPrs[thread.id]);
  const [info, setInfo] = useState<GitInfo>();
  const [pr, setPr] = useState<PrStatus | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [msg, setMsg] = useState('');
  const [comments, setComments] = useState<LineComment[]>([]);
  const toast = useStore(s => s.toast);

  const load = useCallback(() => {
    api.get<Changes>(`/api/threads/${thread.id}/changes`).then(d => {
      setData(d);
      if (!d.repo) return;
      api.get<GitInfo>(`/api/threads/${thread.id}/git`).then(setInfo, () => {});
      api.get<{ pr: PrStatus | null }>(`/api/threads/${thread.id}/pr`).then(r => setPr(r.pr), () => {});
    }).catch(toastError);
  }, [thread.id]);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!data?.repo) return;
    api.get<{ diff: string }>(`/api/threads/${thread.id}/diff${file ? `?file=${encodeURIComponent(file)}` : ''}`).then(r => setDiff(r.diff)).catch(toastError);
  }, [thread.id, file, refreshKey, data]);

  if (!data) return <div className="p-4 space-y-2"><div className="skeleton h-4 w-1/2" /><div className="skeleton h-4 w-3/4" /></div>;
  if (!data.repo) return <p className="p-4 text-sm text-dust">{thread.cwd} isn't a git repository, so there's nothing to diff.</p>;

  const revert = async (f: string) => {
    if (!confirm(`Discard all changes to ${f}?`)) return;
    await api.post(`/api/threads/${thread.id}/revert`, { file: f }).catch(toastError);
    load();
  };
  const commit = async () => {
    const r = await api.post<{ committed: boolean }>(`/api/threads/${thread.id}/commit`, { message: msg || thread.title }).catch(toastError);
    if (r) { toast({ title: r.committed ? 'Committed' : 'Nothing to commit' }); setMsg(''); load(); }
  };
  const openPr = async () => {
    const r = await api.post<{ url: string }>(`/api/threads/${thread.id}/pr`, { message: msg || thread.title }).catch(toastError);
    if (r) { toast({ title: 'Pull request opened', body: r.url, url: r.url }); load(); }
  };
  const sendComments = async () => {
    const body = comments.map(c => `- ${c.file}:${c.line} \`${c.code.trim().slice(0, 120)}\`\n  ${c.text}`).join('\n');
    try { await send(thread, `Review comments on your changes. Address each one:\n\n${body}`); setComments([]); toast({ title: `Sent ${comments.length} comment${comments.length > 1 ? 's' : ''} to the agent` }); }
    catch (e) { toastError(e); }
  };
  const added = data.files.reduce((n, f) => n + f.added, 0), removed = data.files.reduce((n, f) => n + f.removed, 0);

  return (
    <div className="flex flex-col h-full min-h-0">
      {info && <GitBar thread={thread} info={info} reload={load} />}
      {info && (info.conflicts.length > 0 || info.rebasing || info.merging) && (
        <div className="m-2.5 rounded-xl border border-halo/40 bg-halo/[0.06] p-3 space-y-2 animate-rise">
          <p className="flex items-center gap-2 text-[13px] font-bold"><AlertTriangle size={14} className="text-halo" />{info.rebasing ? 'Rebase' : 'Merge'} in progress{info.conflicts.length ? ` · ${info.conflicts.length} conflicted file${info.conflicts.length > 1 ? 's' : ''}` : ''}</p>
          {info.conflicts.length > 0 && <ul className="font-mono text-[12px] text-dust">{info.conflicts.map(c => <li key={c}>{c}</li>)}</ul>}
          <div className="flex gap-2">
            {info.conflicts.length > 0 && <Button size="sm" tone="halo" onClick={() => send(thread, `There are git conflicts in: ${info.conflicts.join(', ')}. Resolve them carefully (keep both sides' intent), then continue the ${info.rebasing ? 'rebase (git rebase --continue)' : 'merge (git commit)'} and run the tests.`).then(() => toast({ title: 'Asked the agent to resolve the conflicts' }), toastError)}><Wand2 size={12} />Ask agent to resolve</Button>}
            <Button size="sm" tone="danger" onClick={() => api.post(`/api/threads/${thread.id}/git`, { action: 'abort' }).then(load, toastError)}>Abort {info.rebasing ? 'rebase' : 'merge'}</Button>
          </div>
        </div>
      )}
      <PullRequests threadId={thread.id} />
      {pr && <PrCard thread={thread} pr={pr} reload={load} compact={!!linkedPrs?.length} />}
      {data.files.length === 0 ? <p className="p-4 text-sm text-dust">No changes yet.</p> : <>
        <ul className="max-h-[34%] overflow-y-auto border-b border-line p-1">
          <li><button onClick={() => setFile(null)} className={`press w-full flex items-center gap-2 text-left px-2.5 py-1 rounded-md text-[13px] ${file === null ? 'bg-ridge text-moon' : 'text-dust hover:text-moon'}`}>
            <span className="flex-1">All files ({data.files.length})</span><span className="font-mono text-[11px] text-sprout">+{added}</span><span className="font-mono text-[11px] text-oxide">−{removed}</span>
          </button></li>
          {data.files.map(f => (
            <li key={f.path} className={`group flex items-center gap-2 px-2.5 py-1 rounded-md text-[13px] ${file === f.path ? 'bg-ridge' : 'hover:bg-ridge/50'}`}>
              <span className={`font-mono w-3 text-center ${statusCls[f.status] ?? 'text-dust'}`}>{f.status === '?' ? 'A' : f.status}</span>
              <button onClick={() => setFile(f.path)} className="font-mono truncate text-left flex-1 min-w-0" data-tip={f.path}>{f.path}</button>
              <span className="font-mono text-[11px] text-sprout">+{f.added}</span><span className="font-mono text-[11px] text-oxide">−{f.removed}</span>
              <button onClick={() => revert(f.path)} aria-label={`Discard changes to ${f.path}`} data-tip="Discard changes" className="press opacity-0 group-hover:opacity-100 focus:opacity-100 text-dust hover:text-oxide"><RotateCcw size={13} /></button>
            </li>
          ))}
        </ul>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <p className="text-[11.5px] text-ash mb-2"><span className="pointer-coarse:hidden">Hover a line and click <span className="text-tide">+</span></span><span className="hidden pointer-coarse:inline">Tap a line</span> to leave a comment for the agent.</p>
          <DiffView diff={diff} comments={comments} onComment={c => setComments(cs => [...cs, { ...c, id: `${Date.now()}` }])} onRemoveComment={id => setComments(cs => cs.filter(c => c.id !== id))} />
        </div>
        {comments.length > 0 && <div className="flex items-center gap-2 px-3 py-2 border-t border-tide/30 bg-tide/[0.06] animate-rise">
          <span className="text-[13px] flex-1">{comments.length} review comment{comments.length > 1 ? 's' : ''}</span>
          <Button size="sm" onClick={() => setComments([])}>Discard</Button>
          <Button size="sm" tone="primary" onClick={sendComments}><Send size={12} />Send to agent</Button>
        </div>}
        <div className="border-t border-line p-2.5 flex gap-2">
          <input className={inputCls + ' h-8.5 py-0'} placeholder={`Commit message (default: ${thread.title})`} value={msg} onChange={e => setMsg(e.target.value)} />
          <Button onClick={commit} data-tip="Commit all changes"><GitCommitHorizontal size={15} />Commit</Button>
          {thread.worktree && !pr && <Button onClick={openPr} data-tip="Commit, push the branch and open a pull request"><GitPullRequest size={15} />PR</Button>}
        </div>
      </>}
    </div>
  );
}
