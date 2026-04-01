/** Get the cursor offset as a plain-text character position within an element */
export function getCursorOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return (el.textContent ?? '').length;

  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

/** Classify cursor position as start, end, or middle */
export function getCursorPosition(el: HTMLElement): 'start' | 'end' | 'middle' {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return 'middle';
  const offset = getCursorOffset(el);
  if (offset === 0) return 'start';
  if (offset >= (el.textContent ?? '').length) return 'end';
  return 'middle';
}
