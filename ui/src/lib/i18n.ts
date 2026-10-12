// A typed dictionary, German and English, and `Intl` for numbers and dates.
// The UI language is not the language of the data: titles stay as written.

export type Lang = 'de' | 'en';

const en = {
  'app.title': 'tasks',
  'nav.today': 'Today',
  'nav.list': 'List',
  'nav.areas': 'Area',
  'nav.all': 'All areas',
  'conn.live': 'live',
  'conn.reconnecting': 'reconnecting',
  'conn.offline': 'hub not reachable',
  'conn.cached': 'from cache',
  'state.loading': 'Loading ...',
  'state.pairing': 'Pairing ...',
  'state.needs_pairing.title': 'This browser is not paired with the hub',
  'state.needs_pairing.body':
    'Start the link from the hub: run the command below in a terminal. It opens this page with a one-time code that works for 60 seconds.',
  'state.unavailable.title': 'The hub is up, the engine is not',
  'state.unavailable.body': 'The hub cannot reach tasks.nvim. Problem code:',
  'state.offline.title': 'The hub is not reachable',
  'state.offline.body': 'Start it with the command below. This page tries again by itself.',
  'state.stale': 'Showing the last known list ({age} old). Waiting for the hub.',
  'today.next': 'Next task',
  'today.why.freed': 'Freed: what it waited for is done',
  'today.why.area': 'Same area as your last work',
  'today.why.vault': 'The best ready task in the vault',
  'today.alternatives': 'Instead',
  'today.waiting': 'Waits for you',
  'today.cdx': 'An AI session could take',
  'today.tiles.ready': 'ready',
  'today.tiles.doing': 'doing',
  'today.tiles.blocked': 'blocked',
  'today.tiles.estimated': 'with value',
  'today.empty.all_done': 'Nothing is open. All done.',
  'today.empty.nothing_startable':
    'Nothing can be started. For you: {for_me}, waiting: {waiting}, blocked: {blocked_status}, parked: {parked}.',
  'today.empty.only_cdx': 'Only tasks for an AI session are ready.',
  'today.incomplete': 'Some folders could not be read: the picture may be incomplete.',
  'list.search': 'Search id and title',
  'list.count': '{shown} of {total}',
  'list.none': 'No task matches.',
  'list.filter.status': 'Status',
  'list.filter.actor': 'Actor',
  'list.help': 'j / k move, Enter opens, / searches, g h Today, g l List',
  'detail.none': 'Select a task.',
  'detail.loading': 'Reading the task ...',
  'detail.failed': 'The task could not be read.',
  'detail.props': 'Properties',
  'detail.waits_on': 'Waits on',
  'detail.after': 'After',
  'detail.steps': 'Steps',
  'detail.body': 'Text',
  'detail.body_truncated': 'The text is cut here; open the file for the rest.',
  'detail.file': 'File',
  'detail.problems': 'Problems with this task',
  'detail.invisible':
    'The text holds characters that are not visible or that change the reading direction. They are marked with ⟦ ⟧.',
  'prop.status': 'Status',
  'prop.kind': 'Kind',
  'prop.prio': 'Priority',
  'prop.effort': 'Effort',
  'prop.value': 'Value',
  'prop.roi': 'Value per day',
  'prop.actor': 'Actor',
  'prop.plan': 'Plan',
  'prop.phase': 'Phase',
  'prop.updated': 'Updated',
  'prop.created': 'Created',
  'prop.area': 'Area',
  'prop.state': 'State',
  'prop.stage': 'Stage',
  'prop.unknown': '?',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.auto': 'System',
  'lang.label': 'Language',
  'theme.label': 'Theme',
  'state.ready': 'ready',
  'state.decision': 'decision',
  'state.waiting': 'waiting',
  'state.stuck': 'stuck',
  'state.freed': 'freed',
  'state.parked': 'parked',
  'state.unknown': 'unknown',
  'status.doing': 'doing',
  'status.decision': 'decision',
  'status.blocked': 'blocked',
  'status.open': 'open',
  'status.parked': 'parked',
  'status.done': 'done',
  'actor.me': 'me',
  'actor.cdx': 'AI',
  'actor.pair': 'pair',
  'ago.seconds': '{n} s',
  'ago.minutes': '{n} min',
  'ago.hours': '{n} h',
  'ago.days': '{n} d',
} as const;

export type Key = keyof typeof en;

const de: Record<Key, string> = {
  'app.title': 'Tasks',
  'nav.today': 'Heute',
  'nav.list': 'Liste',
  'nav.areas': 'Bereich',
  'nav.all': 'Alle Bereiche',
  'conn.live': 'live',
  'conn.reconnecting': 'verbindet neu',
  'conn.offline': 'Hub nicht erreichbar',
  'conn.cached': 'aus dem Cache',
  'state.loading': 'Lade ...',
  'state.pairing': 'Koppeln ...',
  'state.needs_pairing.title': 'Dieser Browser ist nicht mit dem Hub gekoppelt',
  'state.needs_pairing.body':
    'Starte den Link vom Hub: Führe den Befehl unten in einem Terminal aus. Er öffnet diese Seite mit einem Einmal-Code, der 60 Sekunden gilt.',
  'state.unavailable.title': 'Der Hub läuft, die Engine nicht',
  'state.unavailable.body': 'Der Hub erreicht tasks.nvim nicht. Problem-Code:',
  'state.offline.title': 'Der Hub ist nicht erreichbar',
  'state.offline.body': 'Starte ihn mit dem Befehl unten. Diese Seite versucht es selbst erneut.',
  'state.stale': 'Zeigt die zuletzt bekannte Liste ({age} alt). Wartet auf den Hub.',
  'today.next': 'Nächster Task',
  'today.why.freed': 'Frei geworden: worauf er wartete, ist erledigt',
  'today.why.area': 'Gleicher Bereich wie deine letzte Arbeit',
  'today.why.vault': 'Der beste startbare Task im Vault',
  'today.alternatives': 'Stattdessen',
  'today.waiting': 'Wartet auf dich',
  'today.cdx': 'Eine KI-Sitzung könnte übernehmen',
  'today.tiles.ready': 'startbar',
  'today.tiles.doing': 'läuft',
  'today.tiles.blocked': 'blockiert',
  'today.tiles.estimated': 'mit Value',
  'today.empty.all_done': 'Nichts ist offen. Alles erledigt.',
  'today.empty.nothing_startable':
    'Nichts ist startbar. Für dich: {for_me}, wartend: {waiting}, blockiert: {blocked_status}, geparkt: {parked}.',
  'today.empty.only_cdx': 'Startbar sind nur Tasks für eine KI-Sitzung.',
  'today.incomplete': 'Einige Ordner ließen sich nicht lesen: das Bild kann unvollständig sein.',
  'list.search': 'ID und Titel suchen',
  'list.count': '{shown} von {total}',
  'list.none': 'Kein Task passt.',
  'list.filter.status': 'Status',
  'list.filter.actor': 'Akteur',
  'list.help': 'j / k bewegen, Enter öffnet, / sucht, g h Heute, g l Liste',
  'detail.none': 'Wähle einen Task.',
  'detail.loading': 'Lese den Task ...',
  'detail.failed': 'Der Task ließ sich nicht lesen.',
  'detail.props': 'Eigenschaften',
  'detail.waits_on': 'Wartet auf',
  'detail.after': 'Danach',
  'detail.steps': 'Schritte',
  'detail.body': 'Text',
  'detail.body_truncated': 'Der Text ist hier abgeschnitten; für den Rest die Datei öffnen.',
  'detail.file': 'Datei',
  'detail.problems': 'Probleme mit diesem Task',
  'detail.invisible':
    'Der Text enthält unsichtbare Zeichen oder Zeichen, die die Leserichtung ändern. Sie sind mit ⟦ ⟧ markiert.',
  'prop.status': 'Status',
  'prop.kind': 'Art',
  'prop.prio': 'Priorität',
  'prop.effort': 'Aufwand',
  'prop.value': 'Value',
  'prop.roi': 'Value pro Tag',
  'prop.actor': 'Akteur',
  'prop.plan': 'Plan',
  'prop.phase': 'Phase',
  'prop.updated': 'Geändert',
  'prop.created': 'Angelegt',
  'prop.area': 'Bereich',
  'prop.state': 'Zustand',
  'prop.stage': 'Stufe',
  'prop.unknown': '?',
  'theme.light': 'Hell',
  'theme.dark': 'Dunkel',
  'theme.auto': 'System',
  'lang.label': 'Sprache',
  'theme.label': 'Darstellung',
  'state.ready': 'startbar',
  'state.decision': 'Entscheidung',
  'state.waiting': 'wartet',
  'state.stuck': 'hängt',
  'state.freed': 'frei geworden',
  'state.parked': 'geparkt',
  'state.unknown': 'unbekannt',
  'status.doing': 'läuft',
  'status.decision': 'Entscheidung',
  'status.blocked': 'blockiert',
  'status.open': 'offen',
  'status.parked': 'geparkt',
  'status.done': 'erledigt',
  'actor.me': 'ich',
  'actor.cdx': 'KI',
  'actor.pair': 'zu zweit',
  'ago.seconds': '{n} s',
  'ago.minutes': '{n} min',
  'ago.hours': '{n} Std',
  'ago.days': '{n} T',
};

export const dictionaries: Record<Lang, Record<Key, string>> = { en, de };

/** Is this one of the languages we have? */
export function isLang(value: unknown): value is Lang {
  return value === 'de' || value === 'en';
}

/** The language a browser asks for, German or else English. */
export function detectLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'de') return 'de';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function translate(
  lang: Lang,
  key: Key,
  params: Record<string, string | number> = {},
): string {
  const text = dictionaries[lang][key];
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** "5 min", "2 h": how long ago, in the unit that fits. */
export function ago(lang: Lang, milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 90) return translate(lang, 'ago.seconds', { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return translate(lang, 'ago.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return translate(lang, 'ago.hours', { n: hours });
  return translate(lang, 'ago.days', { n: Math.round(hours / 24) });
}

export function formatNumber(lang: Lang, value: number): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(value);
}
