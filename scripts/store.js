export const MODULE_ID = "friendly-reminder";
export const FLAG_VERSION = 1;
export const ENTRY_MIME = "application/x-friendly-reminder-entry";
const validId = id => typeof id === "string" && /^[\w-]+$/.test(id);

export const localize = key => game.i18n.localize(`FR.${key}`);

export function reportError(error) {
  console.error(`${MODULE_ID} |`, error);
  ui.notifications.error(localize("SaveError"));
}

/** User document flags live in the world's database, independently of browser origins. */
export class ReminderStore extends EventTarget {
  #queue = Promise.resolve();
  #pending = 0;

  constructor(user, { randomId = () => foundry.utils.randomID() } = {}) {
    super();
    this.user = user;
    this.randomId = randomId;
  }

  get entries() {
    return Object.values(this.user.getFlag(MODULE_ID, "entries") ?? {})
      .filter(entry => entry && typeof entry.html === "string" && validId(entry.id))
      .sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0));
  }

  get folders() {
    return Object.values(this.user.getFlag(MODULE_ID, "folders") ?? {})
      .filter(folder => folder && validId(folder.id) && typeof folder.name === "string")
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  get windowState() {
    return this.user.getFlag(MODULE_ID, "window") ?? {};
  }

  get pending() { return this.#pending; }

  initializeCollapsedDefault() {
    return this.#write(async () => {
      if (this.user.getFlag(MODULE_ID, "defaults.collapsed") === 1) return;
      const prefix = `flags.${MODULE_ID}`;
      const changes = { [`${prefix}.defaults.collapsed`]: 1 };
      for (const entry of this.entries) {
        if (entry.collapsed !== true) changes[`${prefix}.entries.${entry.id}.collapsed`] = true;
      }
      // Apply the new default to existing records once, then keep remembering manual choices.
      await this.user.update(changes);
    });
  }

  #write(task) {
    this.#pending++;
    this.dispatchEvent(new Event("status"));
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result.finally(() => {
      this.#pending--;
      this.dispatchEvent(new Event("status"));
    });
  }

  add(entry, folderId = entry?.folderId ?? null) {
    if (!entry || !validId(entry.id) || typeof entry.html !== "string") {
      return Promise.reject(new Error("Invalid reminder"));
    }
    return this.#write(async () => {
      if (typeof this.user.getFlag(MODULE_ID, `entries.${entry.id}`)?.html === "string") return false;
      const destination = this.folders.some(folder => folder.id === folderId) ? folderId : null;
      await this.user.setFlag(MODULE_ID, `entries.${entry.id}`, { ...entry, folderId: destination });
      return true;
    });
  }

  remove(id) {
    if (!validId(id)) return Promise.reject(new Error("Invalid reminder ID"));
    return this.#write(() => this.user.unsetFlag(MODULE_ID, `entries.${id}`));
  }

  setCollapsed(id, collapsed) {
    if (!validId(id)) return Promise.reject(new Error("Invalid reminder ID"));
    return this.#write(async () => {
      if (!this.user.getFlag(MODULE_ID, `entries.${id}`)) return;
      await this.user.setFlag(MODULE_ID, `entries.${id}.collapsed`, Boolean(collapsed));
    });
  }

  createFolder(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > 80) return Promise.reject(new Error("Invalid folder name"));
    return this.#write(async () => {
      const id = this.randomId();
      if (!validId(id) || this.folders.some(folder => folder.id === id)) throw new Error("Invalid folder ID");
      const folder = { id, name: trimmed, createdAt: Date.now(), collapsed: false };
      await this.user.setFlag(MODULE_ID, `folders.${id}`, folder);
      return folder;
    });
  }

  setFolderCollapsed(id, collapsed) {
    if (!validId(id)) return Promise.reject(new Error("Invalid folder ID"));
    return this.#write(async () => {
      if (!this.folders.some(folder => folder.id === id)) return;
      await this.user.setFlag(MODULE_ID, `folders.${id}.collapsed`, Boolean(collapsed));
    });
  }

  move(id, folderId = null) {
    if (!validId(id) || (folderId !== null && !validId(folderId))) {
      return Promise.reject(new Error("Invalid reminder destination"));
    }
    return this.#write(async () => {
      if (!this.entries.some(entry => entry.id === id)) return;
      if (folderId !== null && !this.folders.some(folder => folder.id === folderId)) {
        throw new Error("Reminder folder no longer exists");
      }
      await this.user.setFlag(MODULE_ID, `entries.${id}.folderId`, folderId);
    });
  }

  deleteFolder(id, { deleteContents = false } = {}) {
    if (!validId(id)) return Promise.reject(new Error("Invalid folder ID"));
    return this.#write(async () => {
      if (!this.folders.some(folder => folder.id === id)) return;
      const prefix = `flags.${MODULE_ID}`;
      const changes = { [`${prefix}.folders.-=${id}`]: null };
      for (const entry of this.entries.filter(entry => entry.folderId === id)) {
        if (deleteContents) changes[`${prefix}.entries.-=${entry.id}`] = null;
        else changes[`${prefix}.entries.${entry.id}.folderId`] = null;
      }
      // Move/remove contents and delete the folder in one database update.
      await this.user.update(changes);
    });
  }

  clearAll() {
    // Keep the folder structure and the player's window preferences.
    return this.#write(() => this.user.unsetFlag(MODULE_ID, "entries"));
  }

  saveWindow(state) {
    // Write individual fields so one tab's position cannot replace another tab's zoom setting.
    return this.#write(() => this.user.update(Object.fromEntries(
      Object.entries(state).map(([key, value]) => [`flags.${MODULE_ID}.window.${key}`, value])
    )));
  }

  async flush() { await this.#queue; }
}

/** Republish a visual copy, without the source's roll data or automation flags. */
export function makeRepostData(entry, userId, content) {
  const source = entry.source ?? {};
  const recipients = Array.isArray(source.whisper) ? [...source.whisper] : [];
  // Keep whispers private, including when the original sender was their only recipient.
  if (recipients.length && !recipients.includes(userId)) recipients.push(userId);
  return {
    type: "base",
    author: userId,
    style: source.style ?? 0,
    speaker: { ...(source.speaker ?? {}), alias: source.alias ?? source.speaker?.alias ?? "" },
    content,
    whisper: recipients,
    blind: Boolean(source.blind),
    sound: null,
    rolls: [],
    flags: {
      [MODULE_ID]: {
        snapshot: { version: FLAG_VERSION, html: entry.html, originId: entry.id }
      }
    }
  };
}
