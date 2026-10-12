<script lang="ts">
  import { onMount } from 'svelte';
  import type { App } from './lib/app.svelte';
  import { ago, translate, type Key } from './lib/i18n';
  import Today from './views/Today.svelte';
  import ListView from './views/ListView.svelte';

  let { app, code }: { app: App; code: string | null } = $props();

  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let chord = $state(false);
  let searchBox = $state<HTMLInputElement | null>(null);

  onMount(() => {
    void app.start(code);
    const onFocus = () => void app.focused();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      app.stop();
    };
  });

  $effect(() => {
    document.documentElement.lang = app.lang;
    if (app.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = app.theme;
  });

  function typing(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  function onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
    if (app.phase !== 'ready') return;
    if (chord) {
      chord = false;
      if (event.key === 'h') app.view = 'today';
      if (event.key === 'l') app.view = 'list';
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'g':
        chord = true;
        break;
      case 'j':
        if (app.view === 'list') app.moveSelection(1);
        break;
      case 'k':
        if (app.view === 'list') app.moveSelection(-1);
        break;
      case '/':
        if (app.view === 'list') {
          event.preventDefault();
          searchBox?.focus();
        }
        break;
      case 'Escape':
        app.select(null);
        break;
    }
  }

  const age = $derived(
    app.cachedAt === null ? '' : ago(app.lang, Date.now() - app.cachedAt),
  );
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header class="bar">
    <strong class="brand">{t('app.title')}</strong>
    {#if app.phase === 'ready'}
      <nav aria-label="Views">
        <button
          type="button"
          class="tab"
          aria-current={app.view === 'today' ? 'page' : undefined}
          onclick={() => (app.view = 'today')}>{t('nav.today')}</button
        >
        <button
          type="button"
          class="tab"
          aria-current={app.view === 'list' ? 'page' : undefined}
          onclick={() => (app.view = 'list')}>{t('nav.list')}</button
        >
      </nav>
    {/if}
    <span class="spacer"></span>
    {#if app.phase === 'ready'}
      <span class="conn conn-{app.connection}" role="status">
        {app.cachedAt !== null ? t('conn.cached') : t(`conn.${app.connection}` as Key)}
      </span>
    {/if}
    <label class="pref">
      <span class="sr-only">{t('lang.label')}</span>
      <select
        value={app.lang}
        onchange={(e) => app.setLang(e.currentTarget.value === 'de' ? 'de' : 'en')}
      >
        <option value="de">DE</option>
        <option value="en">EN</option>
      </select>
    </label>
    <label class="pref">
      <span class="sr-only">{t('theme.label')}</span>
      <select
        value={app.theme}
        onchange={(e) => {
          const v = e.currentTarget.value;
          app.setTheme(v === 'light' || v === 'dark' ? v : 'auto');
        }}
      >
        <option value="auto">{t('theme.auto')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
    </label>
  </header>

  <main>
    {#if app.phase === 'starting'}
      <p class="note">{t('state.loading')}</p>
    {:else if app.phase === 'needs_pairing'}
      <section class="card centered">
        <h1>{t('state.needs_pairing.title')}</h1>
        <p>{t('state.needs_pairing.body')}</p>
        <pre><code>tasks-hub open</code></pre>
      </section>
    {:else if app.phase === 'offline'}
      <section class="card centered">
        <h1>{t('state.offline.title')}</h1>
        <p>{t('state.offline.body')}</p>
        <pre><code>tasks-hub serve</code></pre>
      </section>
    {:else if app.phase === 'unavailable'}
      <section class="card centered">
        <h1>{t('state.unavailable.title')}</h1>
        <p>{t('state.unavailable.body')} <code>{app.problem}</code></p>
      </section>
    {:else}
      {#if app.cachedAt !== null}
        <p class="banner">{t('state.stale', { age })}</p>
      {/if}
      {#if app.view === 'today'}
        <Today {app} />
      {:else}
        <ListView {app} bind:searchBox />
      {/if}
    {/if}
  </main>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    letter-spacing: 0.02em;
  }
  nav {
    display: flex;
    gap: 0.25rem;
  }
  .tab {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    padding: 0.25rem 0.75rem;
    cursor: pointer;
    color: var(--muted);
  }
  .tab[aria-current='page'] {
    color: var(--text);
    background: var(--surface-2);
    border-color: var(--border);
  }
  .spacer {
    flex: 1;
  }
  .conn {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .conn-live {
    color: var(--ok);
  }
  .conn-offline {
    color: var(--bad);
  }
  .pref select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.2rem 0.4rem;
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem;
  }
  .note {
    color: var(--muted);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .centered {
    max-width: 38rem;
    margin: 3rem auto;
  }
  .banner {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.4rem 0.75rem;
    margin: 0 0 1rem;
    color: var(--warn);
  }
  pre {
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 0.6rem 0.8rem;
    overflow: auto;
  }
</style>
