// Voice via the platform's own speech APIs (dictation + read-aloud): works on the phone without any server audio.
const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
export const canDictate = !!SR;
export const canSpeak = 'speechSynthesis' in window;

// Hands-free: dictation auto-sends, replies are read aloud, then it listens again.
export const handsFree = { on: localStorage.getItem('gibbous.handsFree') === '1' };
export function setHandsFree(on: boolean) { handsFree.on = on; localStorage.setItem('gibbous.handsFree', on ? '1' : '0'); dispatchEvent(new CustomEvent('gibbous:handsfree')); }

export function dictate(onText: (text: string, final: boolean) => void, onEnd: () => void) {
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e: any) => {
    const r = [...e.results].map((x: any) => x[0].transcript).join('');
    onText(r, e.results[e.results.length - 1].isFinal);
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  rec.start();
  return () => rec.stop();
}

// Strip markdown so code fences and links aren't read out character by character.
const plain = (md: string) => md.replace(/```[\s\S]*?```/g, ' (code block) ').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*_>|-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function speak(md: string, onEnd?: () => void) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain(md).slice(0, 4000));
  u.lang = navigator.language || 'en-US';
  u.onend = () => onEnd?.();
  speechSynthesis.speak(u);
}
export const stopSpeaking = () => speechSynthesis.cancel();
