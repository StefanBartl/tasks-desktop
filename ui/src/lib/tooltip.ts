// One explanation popup for the whole page. Any element with `data-hint="text"` gets it: on hover (after a short
// delay) and on keyboard focus. It can be reached with the pointer (it stays while the pointer is on it) and goes
// away with Escape, on scrolling and when the pointer or the focus leaves (WCAG 1.4.13). The text is set as text,
// never as markup.

import { translate } from './i18n';

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
  // The name of the region comes from the dictionary like every other word of the page.
  const regionLabel = (): string => translate(doc.documentElement.lang.startsWith('de') ? 'de' : 'en', 'hint.region');

  let current: HTMLElement | null = null;
  let describedBefore: string | null = null;
  let viaFocus = false;
  let showTimer: number | undefined;
  let hideTimer: number | undefined;

  const hintOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof win.Element ? target.closest<HTMLElement>('[data-hint]') : null;

  // A timer that is replaced is stopped first: a lost timer would still fire and take the popup away (or the
  // pending show of the next element) under the pointer.
  function cancelShow(): void {
    win.clearTimeout(showTimer);
    showTimer = undefined;
  }
  function cancelHide(): void {
    win.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  function scheduleHide(): void {
    cancelHide();
    hideTimer = win.setTimeout(hide, HIDE_DELAY_MS);
  }

  /** The element describes itself (`Info.svelte` keeps the text in the page): the popup adds nothing to it. */
  const ownsDescription = (el: HTMLElement): boolean => el.hasAttribute('data-hint-own');

  function hide(): void {
    cancelShow();
    cancelHide();
    if (current && !ownsDescription(current)) {
      // Only what this popup added is taken away: a description the element had of its own stays.
      const rest = withoutToken(current.getAttribute('aria-describedby'), TIP_ID);
      if (rest === '' && describedBefore === null) current.removeAttribute('aria-describedby');
      else current.setAttribute('aria-describedby', rest);
    }
    current = null;
    viaFocus = false;
    tip.hidden = true;
    host.hidden = true;
    if (host.parentElement !== doc.body) doc.body.appendChild(host);
  }

  function place(el: HTMLElement): void {
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

  function show(el: HTMLElement, byFocus: boolean): void {
    const text = el.dataset.hint ?? '';
    if (text === '') return hide();
    if (current && current !== el) hide();
    // The same element again (hovered, then clicked and focused): what it described before is not read anew,
    // or the popup's own id would count as the element's.
    if (current !== el) describedBefore = el.getAttribute('aria-describedby');
    current = el;
    viaFocus = viaFocus || byFocus;
    tip.textContent = text;
    host.setAttribute('aria-label', regionLabel());
    // A modal dialog lies in the top layer and makes the rest of the page inert: a popup in the body would be behind it
    // and could not be reached with the pointer. While a hint of the dialog is open the popup lives in the dialog.
    const parent = el.closest('dialog') ?? doc.body;
    if (host.parentElement !== parent) parent.appendChild(host);
    host.hidden = false;
    tip.hidden = false;
    if (!ownsDescription(el)) el.setAttribute('aria-describedby', withToken(describedBefore, TIP_ID));
    place(el);
  }

  const onOver = (e: Event): void => {
    if (e.target instanceof win.Node && tip.contains(e.target)) {
      cancelHide();
      return;
    }
    const el = hintOf(e.target);
    if (!el) {
      cancelShow();
      if (!tip.hidden) scheduleHide();
      return;
    }
    cancelHide();
    if (el === current) return;
    cancelShow();
    showTimer = win.setTimeout(() => show(el, false), SHOW_DELAY_MS);
  };
  const onOut = (e: Event): void => {
    cancelShow();
    if (!tip.hidden && (hintOf(e.target) || (e.target instanceof win.Node && tip.contains(e.target)))) {
      scheduleHide();
    }
  };
  const onFocusIn = (e: Event): void => {
    const el = hintOf(e.target);
    if (el) show(el, true);
  };
  const onFocusOut = (): void => hide();
  const onKey = (e: KeyboardEvent): void => {
    // The popup is closed by this Escape and by nothing else: it is not also the Escape of a dialog or a menu. A
    // modal dialog closes on Escape by its own default action (`cancel`), which `stopPropagation` does not stop.
    if (e.key === 'Escape' && !tip.hidden) {
      hide();
      e.stopPropagation();
      e.preventDefault();
    }
  };
  const onScroll = (): void => {
    if (tip.hidden) return;
    // The browser scrolls a focused element into view after `focusin`: the popup follows it. A scroll with the
    // pointer takes the popup away (it would stand where the element no longer is).
    if (viaFocus && current) place(current);
    else hide();
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
