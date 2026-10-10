// Sideways scrollers (code blocks, tables, the subagent pager, chip rows) keep their own horizontal swipes.
export function inScroller(el: EventTarget | null) {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
  }
  return false;
}
