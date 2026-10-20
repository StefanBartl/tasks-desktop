<script lang="ts">
  // The vaults the hub can read: which one is read now, choose another, forget one, add a folder. The hub reads one
  // vault at a time; choosing another loads the page again. Adding a folder is the person's decision, so the dialog
  // says what it means before the button, and the request says it was confirmed.
  import type { App } from '../lib/app.svelte';
  import { translate, type Key } from '../lib/i18n';
  import Info from 'appkit-ui/Info.svelte';

  let { app }: { app: App } = $props();
  const t = (key: Key, params: Record<string, string | number> = {}) =>
    translate(app.lang, key, params);

  let dialog: HTMLDialogElement | undefined = $state();
  let name = $state('');
  let path = $state('');
  const list = $derived(app.vaultList);

  $effect(() => {
    if (!dialog) return;
    if (app.managingVaults && !dialog.open) dialog.showModal();
    if (!app.managingVaults && dialog.open) dialog.close();
  });

  async function add(): Promise<void> {
    if (name.trim() === '' || path.trim() === '') return;
    if (await app.addVault(name, path)) {
      name = '';
      path = '';
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="vaults-title"
  onclose={() => {
    if (app.managingVaults) app.closeVaults();
  }}
>
  <h2 id="vaults-title">{t('vaults.title')}</h2>
  <Info hint={t('hint.vaults.active')} label={t('hint.about', { what: t('vaults.active') })} />
  <p class="muted">{t('vaults.intro')}</p>
  {#if list}
    <ul class="vaults">
      {#each list.vaults as vault (vault.name)}
        <li>
          <span class="what"><strong>{vault.name}</strong> <span class="muted">{vault.label}</span></span>
          {#if vault.name === list.active}
            <span class="tag soft" data-hint={t('hint.vaults.active')}>{t('vaults.active')}</span>
          {:else}
            <button
              type="button"
              disabled={app.vaultBusy}
              aria-label={`${t('vaults.choose')}: ${vault.name}`}
              onclick={() => void app.selectVault(vault.name)}>{t('vaults.choose')}</button
            >
            {#if !vault.main}
              <button
                type="button"
                disabled={app.vaultBusy}
                aria-label={`${t('vaults.remove')}: ${vault.name}`}
                onclick={() => void app.removeVault(vault.name)}>{t('vaults.remove')}</button
              >
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <h3>{t('vaults.add_title')}</h3>
  <div class="add" role="group" aria-label={t('vaults.add_title')}>
    <label>
      <span>{t('vaults.name')} <small>({t('vaults.name_hint')})</small></span>
      <input type="text" bind:value={name} maxlength="40" disabled={app.vaultBusy} />
    </label>
    <label>
      <span>{t('vaults.path')} <small>({t('vaults.path_hint')})</small></span>
      <input type="text" bind:value={path} maxlength="1024" disabled={app.vaultBusy} />
    </label>
    <p class="warn">{t('vaults.warn')}</p>
  </div>
  <div class="actions">
    <button type="button" onclick={() => app.closeVaults()}>{t('vaults.close')}</button>
    <button
      type="button"
      class="primary"
      disabled={app.vaultBusy || name.trim() === '' || path.trim() === ''}
      onclick={() => void add()}>{t('vaults.add')}</button
    >
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
  .vaults {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.4rem;
  }
  .vaults li {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .what {
    flex: 1 1 auto;
    overflow-wrap: anywhere;
  }
  .add {
    display: grid;
    gap: 0.5rem;
  }
  .add label {
    display: grid;
    gap: 0.15rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .warn {
    margin: 0;
    color: var(--warn);
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  button,
  input {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.3rem 0.7rem;
    font-size: 0.9rem;
  }
  button {
    cursor: pointer;
  }
  .primary {
    border-color: var(--accent);
  }
  :disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
