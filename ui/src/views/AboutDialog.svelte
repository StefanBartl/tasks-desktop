<script lang="ts">
  // What this build is and which engine answers (rule APP-09), and the bug report: a text without any path that the
  // person reads here, copies, or takes to a new issue in the browser. The page sends nothing.
  import { tick } from 'svelte';
  import type { App } from '../lib/app.svelte';
  import { engineMatchesPin, issueUrl, reportText } from '../lib/about';
  import { hintOf, translate, type Key } from '../lib/i18n';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let formLink: HTMLAnchorElement | undefined = $state();
  const open = $derived(app.about.state !== 'closed');
  const doc = $derived(app.about.state === 'ok' ? app.about.doc : null);
  const report = $derived(doc ? reportText(app.lang, doc) : '');
  const url = $derived(doc ? issueUrl(app.lang, doc) : '');
  const match = $derived(doc ? engineMatchesPin(doc) : null);
  const unknown = $derived(t('about.unknown'));

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  // "Report a problem" lands on the link to the form, once the words are there.
  $effect(() => {
    if (app.about.state === 'ok' && app.about.focus === 'report') {
      void tick().then(() => formLink?.focus());
    }
  });

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(report);
      app.tell('ok', 'about.copied');
    } catch {
      app.tell('error', 'about.copy_failed');
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="about-title"
  onclose={() => {
    if (app.about.state !== 'closed') app.closeAbout();
  }}
>
  <h2 id="about-title">{t('about.title')}</h2>
  {#if app.about.state === 'loading'}
    <p class="muted" role="status">{t('about.loading')}</p>
  {:else if app.about.state === 'failed'}
    <p role="alert">{t('about.failed', { message: app.about.message })}</p>
  {:else if doc}
    <dl>
      <dt>{t('about.version')}</dt>
      <dd><code>{doc.version}</code></dd>
      <dt><span data-hint={hintOf(app.lang, 'hint.about', 'build')}>{t('about.build')}</span></dt>
      <dd>{#if doc.build}<code>{doc.build}</code>{:else}{t('about.build_release')}{/if}</dd>
      <dt>{t('about.platform')}</dt>
      <dd>{doc.os} {doc.arch}</dd>
      <dt>{t('about.engine')}</dt>
      <dd>
        {#if doc.engine}
          {doc.engine.version ?? unknown}, <code>{doc.engine.git ?? unknown}</code>, Neovim {doc.engine.nvim ?? unknown}
        {:else}
          {t('about.engine_none')}
        {/if}
      </dd>
      <dt><span data-hint={hintOf(app.lang, 'hint.about', 'pinned')}>{t('about.pinned_engine')}</span></dt>
      <dd><code>{doc.pinned.engine ?? unknown}</code></dd>
      <dt><span data-hint={hintOf(app.lang, 'hint.about', 'pinned')}>{t('about.pinned_lib')}</span></dt>
      <dd><code>{doc.pinned.lib ?? unknown}</code></dd>
    </dl>
    {#if match === false}
      <p class="warn">{t('about.engine_differs')}</p>
    {:else if match === true}
      <p class="muted">{t('about.engine_same')}</p>
    {/if}

    <h3>{t('about.report_title')}</h3>
    <p class="muted">{t('about.report_intro')}</p>
    <textarea readonly rows="7" aria-label={t('about.report_text')} value={report}></textarea>
  {/if}
  <div class="actions">
    {#if doc}
      <button type="button" onclick={() => void copy()}>{t('about.copy')}</button>
      <a class="button primary" href={url} target="_blank" rel="noopener noreferrer" bind:this={formLink}
        >{t('about.report_open')}</a
      >
    {/if}
    <button type="button" onclick={() => app.closeAbout()}>{t('about.close')}</button>
  </div>
</dialog>

<style>
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    width: min(36rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }
  h3 {
    margin: 1rem 0 0.4rem;
    font-size: 0.95rem;
  }
  .muted {
    color: var(--muted);
  }
  .warn {
    color: var(--warn);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.2rem 1rem;
    margin: 0 0 0.5rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-family: var(--mono);
    font-size: 0.85rem;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem;
    resize: vertical;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }
  button,
  .button {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.7rem;
    font-size: 0.9rem;
    text-decoration: none;
    cursor: pointer;
  }
  .primary {
    border-color: var(--accent);
  }
</style>
