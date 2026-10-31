// The folder the person works in, in the web variant: choosing it (File System Access API), the folders used before
// (their handles in IndexedDB), and the permission to read them, which the browser asks again after a restart.
//
// The code is the kit's (appkit-web/folder); this names what is the tasks page's own: the mode it asks for, the id the
// picker remembers its start folder under, and the database its handles are kept in. Every local file shares the origin
// file://, so another app's page (testing-web) keeps its handles in a database of its own name, never in this one.

import {
  grantAccess as kitGrantAccess,
  permissionOf as kitPermissionOf,
  pickFolder as kitPickFolder,
  type AccessMode,
  type DirHandle,
  type PermissionState,
  type PickerWindow,
  type PickResult,
} from 'appkit-web/folder';

export {
  displayName,
  idbKeyValue,
  MAX_RECENT,
  oneLine,
  pickerSupport,
  RecentFolders,
  type AccessMode,
  type DirHandle,
  type KeyValue,
  type PermissionState,
  type PickerWindow,
  type PickResult,
  type Recent,
  type Support,
} from 'appkit-web/folder';

/** The mode asked for. `readwrite` from the start, so that writing (step 8) does not ask a second time. */
export const MODE: AccessMode = 'readwrite';
/** The picker remembers the last folder per id and starts there. */
export const PICKER_ID = 'tasks-web-vault';
/** The database of the folders used before (the store in it: `handles`). */
export const HANDLES_DB = 'tasks-web';

/** Ask the person for a folder. Must run inside a click: the browser refuses the picker without one. */
export function pickFolder(win: PickerWindow): Promise<PickResult> {
  return kitPickFolder(win, { id: PICKER_ID, mode: MODE });
}

/** The permission a stored handle has now; `gone` when the folder does not exist any more. */
export function permissionOf(handle: DirHandle): Promise<PermissionState | 'gone'> {
  return kitPermissionOf(handle, MODE);
}

/** Ask for the permission again. Must run inside a click (the first thing the click handler does). */
export function grantAccess(handle: DirHandle): Promise<PermissionState | 'gone'> {
  return kitGrantAccess(handle, MODE);
}
