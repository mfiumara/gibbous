// Export a thread: Markdown from the timeline, or a self-contained HTML snapshot of what's on screen.
import type { Item } from './timeline';

export function toMarkdown(title: string, items: Item[]) {
  const out = [`# ${title}`, ''];
  for (const it of items) {
    if (it.kind === 'user') out.push(`**You:**\n\n${it.text}`, '');
    else if (it.kind === 'assistant') out.push(it.text, '');
    else if (it.kind === 'tool') out.push(`> \`${it.name}\`${typeof it.args?.command === 'string' ? ` — \`${it.args.command}\`` : typeof it.args?.path === 'string' ? ` — ${it.args.path}` : ''}`, '');
    else if (it.kind === 'side') out.push(`**Side question:** ${it.question}\n\n${it.text ?? ''}`, '');
    else if (it.kind === 'notice') out.push(`_${it.text}_`, '');
  }
  return out.join('\n');
}

const toDataUrl = (src: string) => fetch(src, { credentials: 'same-origin' }).then(r => r.blob()).then(b => new Promise<string>(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); })).catch(() => src);

// Clone the rendered timeline, inline its images, and embed the app's CSS so it reads exactly like Gibbous.
export async function toHtml(title: string, root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, [aria-hidden="true"]').forEach(b => { if (!b.closest('pre')) (b as HTMLElement).remove(); });
  await Promise.all([...clone.querySelectorAll('img')].map(async img => { img.src = await toDataUrl(img.getAttribute('src') ?? ''); }));
  const css = [...document.styleSheets].map(s => { try { return [...s.cssRules].map(r => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
  const theme = document.documentElement.dataset.theme ?? 'night';
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}\nbody{overflow:auto}</style></head>` +
    `<body><main class="mx-auto max-w-3xl px-4 py-10"><p class="label mb-2">Shared from Gibbous · ${new Date().toLocaleString()}</p><h1 class="text-[26px] font-bold mb-6">${esc(title)}</h1>${clone.innerHTML}</main></body></html>`;
}

// Phones hand files to the share sheet (Files, Messages, AirDrop); everything else downloads.
export const touch = () => matchMedia('(pointer: coarse)').matches;
export function download(name: string, text: string, type: string) {
  const file = new File([text], name, { type });
  if (touch() && navigator.canShare?.({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
