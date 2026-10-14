import { api, type Thread } from './api';
import { useStore, toastError } from './store';
import { go } from './ui';

// Fork a thread into a new one in the same project and folder (server forkThread). `at`: a stored message row; a user
// message comes back as the fork's draft so it can be edited before sending. No `at`: the whole conversation.
let busy = false;
export async function forkThread(threadId: string, at?: number) {
  if (busy) return;
  busy = true;
  try {
    const { thread, draft } = await api.post<{ thread: Thread; draft?: string }>(`/api/threads/${threadId}/fork`, at != null ? { at } : {});
    if (draft) localStorage.setItem(`gibbous.draft.t:${thread.id}`, draft);
    go(`/t/${thread.id}`);
    useStore.getState().toast({ title: draft ? 'Forked: edit the message and send it' : 'Forked into a new thread' });
  } catch (e) { toastError(e); } finally { busy = false; }
}
