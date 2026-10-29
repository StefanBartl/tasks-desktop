// The vault part of the menu "Project": which vault is read, the others the hub can read, and what is done with its
// folder. The web variant has no hub and nothing on the machine it could start: it reads the one folder the person
// chose in the browser, so the entry that shows the folder in the file explorer (`vault_reveal`) is not offered there.

import type { MenuItem } from 'appkit-ui/menu';
import type { App } from './app.svelte';
import { translate, type Key } from './i18n';

/** What the entries need of the page. */
export type VaultMenuApp = Pick<
  App,
  'lang' | 'phase' | 'snapshot' | 'tasks' | 'vaultList' | 'vaultBusy' | 'machineActions' | 'selectVault' | 'revealVault' | 'openVaults'
>;

export function vaultMenuItems(app: VaultMenuApp): MenuItem[] {
  const t = (key: Key, params: Record<string, string | number> = {}) => translate(app.lang, key, params);
  const ready = app.phase === 'ready';
  const vault = app.snapshot?.vault?.id;
  const areas = new Set(app.tasks.map((x) => x.area)).size;
  return [
    { kind: 'section', label: t('menu.sec.vault') },
    ...(vault ? [{ kind: 'info' as const, label: t('menu.vault', { name: vault }) }] : []),
    ...(ready ? [{ kind: 'info' as const, label: t('menu.vault_info', { areas, tasks: app.tasks.length }) }] : []),
    ...(app.vaultList?.vaults ?? []).map((v) => ({
      kind: 'radio' as const,
      label: v.name === 'main' ? `${v.label} (main)` : `${v.name} (${v.label})`,
      checked: v.name === app.vaultList?.active,
      disabled: !ready || app.vaultBusy,
      hint: t('hint.item.menu.vault_switch'),
      onselect: () => void app.selectVault(v.name),
    })),
    ...(app.machineActions
      ? [
          {
            kind: 'action' as const,
            label: t('menu.vault_reveal'),
            hint: t('hint.item.menu.vault_reveal'),
            disabled: !ready || app.vaultBusy,
            onselect: () => void app.revealVault(),
          },
        ]
      : []),
    {
      kind: 'action' as const,
      label: t('menu.vaults_manage'),
      hint: t('hint.item.menu.vaults_manage'),
      disabled: !ready || !app.vaultList,
      onselect: () => app.openVaults(),
    },
  ];
}
