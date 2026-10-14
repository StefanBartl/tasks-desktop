// One explanation popup for the whole page. Any element with `data-hint="text"` gets it: on hover (after a short
// delay) and on keyboard focus. It can be reached with the pointer (it stays while the pointer is on it) and goes
// away with Escape, on scrolling and when the pointer or the focus leaves (WCAG 1.4.13). The text is set as text,
// never as markup.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the popup goes: below the element, above it when there is no room below, and kept inside the window.
 */
export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
  gap = 6,
): { x: number; y: number } {
  let y = anchor.y + anchor.height + gap;
  if (y + tip.height > view.height && anchor.y - gap - tip.height >= 0) y = anchor.y - gap - tip.height;
  y = Math.max(0, Math.min(y, Math.max(0, view.height - tip.height)));
  const x = Math.max(0, Math.min(anchor.x, Math.max(0, view.width - tip.width)));
  return { x, y };
}

/** The pause before a popup shows on hover, and the one before it goes when the pointer left. */
export const SHOW_DELAY_MS = 300;
export const HIDE_DELAY_MS = 150;

export const TIP_ID = 'hint-tip';

/** Join an id into a space separated list (`aria-describedby`) and take it out again. */
export function withToken(list: string | null, token: string): string {
  const tokens = (list ?? '').split(/\s+/).filter(Boolean);
  return (tokens.includes(token) ? tokens : [...tokens, token]).join(' ');
}
export function withoutToken(list: string | null, token: string): string {
  return (list ?? '')
    .split(/\s+/)
    .filter((t) => t !== '' && t !== token)
    .join(' ');
}

/** Install the popup on a document. Returns a function that takes it away again. */
export function installTooltips(doc: Document, win: Window & typeof globalThis): () => void {
  // The popup lives in a region of its own that is there only while a hint is open: content outside every
  // landmark is a finding of its own, and an always present empty region would be noise for a screen reader.
  const host = doc.createElement('div');
  host.className = 'hint-host';
  host.setAttribute('role', 'region');
  host.hidden = true;
  const tip = doc.createElement('div');
  tip.id = TIP_ID;
  tip.className = 'hint-tip';
  tip.setAttribute('role', 'tooltip');
  host.appendChild(tip);
  doc.body.appendChild(host);
  const regionLabel = (): string => (doc.documentElement.lang.startsWith('de') ? 'Erklärung' : 'Explanation');

  let current: HTMLElement | null = null;
  let describedBefore: string | null = null;
  let showTimer: number | undefined;
  let hideTimer: number | undefined;

  const hintOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof win.Element ? target.closest<HTMLElement>('[data-hint]') : null;

  function cancel(): void {
    win.clearTimeout(showTimer);
    win.clearTimeout(hideTimer);
  }

  function hide(): void {
    cancel();
    if (current) {
      // Only what this popup added is taken away: a description the element had of its own stays.
      const rest = withoutToken(current.getAttribute('aria-describedby'), TIP_ID);
      if (rest === '' && describedBefore === null) current.removeAttribute('aria-describedby');
      else current.setAttribute('aria-describedby', rest);
      current = null;
    }
    tip.hidden = true;
    host.hidden = true;
  }

  function show(el: HTMLElement): void {
    const text = el.dataset.hint ?? '';
    if (text === '') return hide();
    if (current && current !== el) hide();
    current = el;
    describedBefore = el.getAttribute('aria-describedby');
    tip.textContent = text;
    host.setAttribute('aria-label', regionLabel());
    host.hidden = false;
    tip.hidden = false;
    el.setAttribute('aria-describedby', withToken(describedBefore, TIP_ID));
    const anchor = el.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const at = placeTip(
      { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
      { width: size.width, height: size.height },
      { width: win.innerWidth, height: win.innerHeight },
    );
    tip.style.left = `${at.x}px`;
    tip.style.top = `${at.y}px`;
  }

  const onOver = (e: Event): void => {
    if (e.target instanceof win.Node && tip.contains(e.target)) {
      win.clearTimeout(hideTimer);
      return;
    }
    const el = hintOf(e.target);
    if (!el) {
      if (!tip.hidden) hideTimer = win.setTimeout(hide, HIDE_DELAY_MS);
      return;
    }
    win.clearTimeout(hideTimer);
    if (el === current) return;
    win.clearTimeout(showTimer);
    showTimer = win.setTimeout(() => show(el), SHOW_DELAY_MS);
  };
  const onOut = (e: Event): void => {
    win.clearTimeout(showTimer);
    if (!tip.hidden && (hintOf(e.target) || (e.target instanceof win.Node && tip.contains(e.target)))) {
      hideTimer = win.setTimeout(hide, HIDE_DELAY_MS);
    }
  };
  const onFocusIn = (e: Event): void => {
    const el = hintOf(e.target);
    if (el) show(el);
  };
  const onFocusOut = (): void => hide();
  const onKey = (e: KeyboardEvent): void => {
    // Not stopped: Escape also closes the dialog or the menu that may be open.
    if (e.key === 'Escape' && !tip.hidden) hide();
  };
  const onScroll = (): void => {
    if (!tip.hidden) hide();
  };

  doc.addEventListener('mouseover', onOver);
  doc.addEventListener('mouseout', onOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('scroll', onScroll, true);
  return () => {
    hide();
    doc.removeEventListener('mouseover', onOver);
    doc.removeEventListener('mouseout', onOut);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('scroll', onScroll, true);
    host.remove();
  };
}
