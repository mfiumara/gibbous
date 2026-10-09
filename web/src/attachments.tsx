// Attachments for every composer: attach, paste (screenshots included), drop. Shared by the thread composer and Home.
import { useState } from 'react';
import { Paperclip, X, FileText } from 'lucide-react';
import { useStore } from './store';

export interface Attachment { name: string; kind: 'image' | 'file'; dataUrl: string; size: number }

const MAX = 50 * 1024 * 1024;
const readDataUrl = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });

// Safari and the macOS app hand pasted screenshots over as clipboard *items*, often with an empty `files` list.
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  if (dt.files.length) return Array.from(dt.files);
  return Array.from(dt.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f);
}

export function useAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]);
  const add = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      if (f.size > MAX) { useStore.getState().toast({ title: `${f.name} is over 50 MB`, tone: 'error' }); continue; }
      const kind = f.type.startsWith('image/') ? 'image' : 'file';
      // Pasted screenshots arrive as "image.png" (or nameless); give them a name you can tell apart.
      const name = !f.name || /^image\.(png|jpe?g)$/i.test(f.name) ? `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` : f.name;
      const dataUrl = await readDataUrl(f);
      setFiles(fs => [...fs, { name, kind, dataUrl, size: f.size }]);
    }
  };
  return { files, setFiles, add, remove: (i: number) => setFiles(fs => fs.filter((_, j) => j !== i)), clear: () => setFiles([]) };
}

const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function AttachmentChips({ files, onRemove }: { files: Attachment[]; onRemove(i: number): void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2.5">
      {files.map((f, i) => (
        <span key={i} className="group/att relative inline-flex items-center gap-2 rounded-xl bg-ridge pl-1 pr-2 py-1 text-xs animate-pop max-w-full">
          {f.kind === 'image'
            ? <img src={f.dataUrl} alt="" className="size-10 rounded-lg object-cover" />
            : <span className="size-10 rounded-lg bg-well grid place-items-center text-dust">{/\.(pdf|md|txt|docx?)$/i.test(f.name) ? <FileText size={16} /> : <Paperclip size={15} />}</span>}
          <span className="min-w-0"><span className="block max-w-44 truncate text-moon">{f.name}</span><span className="block text-[11px] text-ash">{kb(f.size)}</span></span>
          <button aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)} className="press -mr-1 size-7 grid place-items-center rounded-md text-dust hover:text-moon hover:bg-line"><X size={13} /></button>
        </span>
      ))}
    </div>
  );
}

// A new thread's first message with attachments, handed from Home to the thread's composer, which sends it.
const handoff = new Map<string, { text: string; files: Attachment[] }>();
export const handOff = (threadId: string, text: string, files: Attachment[]) => handoff.set(threadId, { text, files });
export const takeHandoff = (threadId: string) => { const h = handoff.get(threadId); handoff.delete(threadId); return h; };
