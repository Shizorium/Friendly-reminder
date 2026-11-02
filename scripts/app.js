import { ENTRY_MIME, localize, makeRepostData, reportError } from "./store.js";
import { snapshotElement } from "./snapshot.js";

export function iconButton(action, icon, label, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `fr-icon ${extraClass}`.trim();
  if (action) button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
  return button;
}

export class ReminderApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "friendly-reminder",
    classes: ["friendly-reminder"],
    window: { title: "Friendly reminder", icon: "fa-solid fa-bookmark", resizable: true, minimizable: true },
    position: { width: 320, height: 440 }
  };

  constructor(store, { onDrop } = {}) {
    super({ position: ReminderApp.initialPosition(store.windowState) });
    this.store = store;
    this.onDrop = onDrop;
    this.zoom = Math.min(1.5, Math.max(0.7, Number(store.windowState.zoom) || 1));
    store.addEventListener("status", () => this.updateStatus());
  }

  static initialPosition(state) {
    const chat = document.querySelector("#chat-message")?.getBoundingClientRect();
    const width = Math.min(Math.max(260, Number(state.width) || chat?.width || 320), window.innerWidth);
    const height = Math.min(Math.max(200, Number(state.height) || 440), window.innerHeight);
    return {
      width, height,
      left: Math.max(0, Math.min(Number.isFinite(state.left) ? state.left : (chat?.left ?? window.innerWidth) - width - 12,
        window.innerWidth - width)),
      top: Math.max(0, Math.min(Number.isFinite(state.top) ? state.top : (chat?.top ?? window.innerHeight) - height - 12,
        window.innerHeight - height))
    };
  }

  async show({ restore = false } = {}) {
    if (!this.rendered) {
      const minimized = restore && this.store.windowState.minimized;
      await this.render({ force: true });
      if (minimized) await this.minimize();
    }
    else {
      if (this.minimized) await this.maximize();
      this.bringToFront();
    }
  }

  async _renderHTML() {
    const panel = document.createElement("div");
    panel.className = "fr-panel";
    const toolbar = document.createElement("div");
    toolbar.className = "fr-toolbar";
    const count = document.createElement("span");
    count.className = "fr-count";
    count.textContent = `${localize("Count")} · ${this.store.entries.length}`;
    const status = document.createElement("i");
    status.className = "fr-status fa-solid fa-check";
    status.setAttribute("role", "status");
    toolbar.append(count, status, iconButton("frZoomOut", "fa-minus", localize("ZoomOut")));
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "fr-zoom";
    zoom.dataset.action = "frZoomReset";
    zoom.title = localize("ZoomReset");
    zoom.textContent = `${Math.round(this.zoom * 100)}%`;
    toolbar.append(zoom, iconButton("frZoomIn", "fa-plus", localize("ZoomIn")));
    const scroll = document.createElement("div");
    scroll.className = "fr-scroll";
    const list = document.createElement("ol");
    const nativeLog = document.querySelector("#chat .chat-log, #chat-notifications .chat-log");
    list.className = nativeLog?.className || "chat-log plain themed theme-light";
    list.classList.add("fr-list");
    const folders = this.store.folders;
    const entries = this.store.entries;
    const folderIds = new Set(folders.map(folder => folder.id));
    for (const folder of folders) {
      list.append(this.createGroup(folder, entries.filter(entry => entry.folderId === folder.id)));
    }
    list.append(this.createGroup(null, entries.filter(entry => !folderIds.has(entry.folderId)), folders.length > 0));
    scroll.append(list);
    if (!entries.length && !folders.length) {
      const empty = document.createElement("div");
      empty.className = "fr-empty";
      const icon = document.createElement("i");
      icon.className = "fa-regular fa-bookmark";
      const title = document.createElement("strong");
      title.textContent = localize("EmptyTitle");
      const hint = document.createElement("span");
      hint.textContent = localize("EmptyHint");
      const menu = document.createElement("small");
      menu.textContent = localize("EmptyMenu");
      empty.append(icon, title, hint, menu);
      scroll.append(empty);
    }
    const footer = document.createElement("div");
    footer.className = "fr-drop-hint";
    footer.textContent = localize("DropHint");
    const management = document.createElement("div");
    management.className = "fr-management";
    const newFolder = iconButton("frNewFolder", "fa-folder-plus", localize("NewFolder"), "fr-text-action");
    newFolder.append(document.createTextNode(localize("NewFolder")));
    const clear = iconButton("frClearAll", "fa-trash", localize("ClearAll"), "fr-text-action fr-delete");
    clear.append(document.createTextNode(localize("ClearAll")));
    clear.disabled = !entries.length;
    management.append(newFolder, clear);
    panel.append(toolbar, management, this.createFolderForm(), scroll, footer);
    return panel;
  }

  createFolderForm() {
    const row = document.createElement("div");
    row.className = "fr-folder-create";
    row.hidden = !this._newFolderOpen;
    const name = document.createElement("input");
    name.type = "text";
    name.className = "fr-folder-name";
    name.required = true;
    name.maxLength = 80;
    name.placeholder = localize("FolderName");
    name.setAttribute("aria-label", localize("FolderName"));
    name.value = this._folderDraft ?? "";
    name.addEventListener("input", () => { this._folderDraft = name.value; });
    name.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void this.submitFolder();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        this._newFolderOpen = false;
        row.hidden = true;
      }
    });
    row.append(name, iconButton("frCreateFolder", "fa-check", localize("CreateFolder")),
      iconButton("frCancelFolder", "fa-xmark", localize("Cancel")));
    return row;
  }

  createGroup(folder, entries, showRoot = true) {
    const group = document.createElement("li");
    group.className = `fr-group ${folder ? "fr-folder" : "fr-root"}`;
    group.dataset.folderId = folder?.id ?? "";
    const header = document.createElement("div");
    header.className = "fr-folder-header";
    header.hidden = !folder && !showRoot;
    const title = document.createElement(folder ? "button" : "span");
    title.className = "fr-folder-title";
    title.textContent = folder?.name ?? localize("Root");
    title.title = title.textContent;
    if (folder) {
      title.type = "button";
      title.dataset.action = "frFolderCollapse";
      const toggle = iconButton("frFolderCollapse", folder.collapsed ? "fa-chevron-right" : "fa-chevron-down",
        localize(folder.collapsed ? "ExpandFolder" : "CollapseFolder"));
      toggle.setAttribute("aria-expanded", String(!folder.collapsed));
      header.append(toggle);
    }
    const icon = document.createElement("i");
    icon.className = `fa-solid ${folder ? "fa-folder" : "fa-inbox"} fr-folder-icon`;
    const count = document.createElement("span");
    count.className = "fr-folder-count";
    count.textContent = String(entries.length);
    header.append(icon, title, count);
    if (folder) {
      header.append(
        iconButton("frFolderKeep", "fa-folder-minus", localize("DeleteFolderKeep"), "fr-delete"),
        iconButton("frFolderDelete", "fa-trash", localize("DeleteFolderContents"), "fr-delete")
      );
    }
    const body = document.createElement("ol");
    body.className = "fr-group-body chat-log plain";
    body.hidden = Boolean(folder?.collapsed);
    for (const entry of entries) body.append(this.createEntry(entry));
    if (!entries.length && (folder || showRoot)) {
      const empty = document.createElement("li");
      empty.className = "fr-group-empty";
      empty.textContent = localize("DropHint");
      body.append(empty);
    }
    group.append(header, body);
    return group;
  }

  createEntry(entry) {
    const wrapper = document.createElement("li");
    wrapper.className = "fr-entry";
    wrapper.dataset.entryId = entry.id;
    wrapper.classList.toggle("fr-collapsed", Boolean(entry.collapsed));
    const controls = document.createElement("div");
    controls.className = "fr-entry-controls";
    const collapse = iconButton("frCollapse", entry.collapsed ? "fa-chevron-right" : "fa-chevron-down",
      localize(entry.collapsed ? "Expand" : "Collapse"));
    collapse.setAttribute("aria-expanded", String(!entry.collapsed));
    const title = document.createElement("button");
    title.type = "button";
    title.className = "fr-entry-title";
    title.dataset.action = "frCollapse";
    title.textContent = entry.title || "Friendly reminder";
    title.title = title.textContent;
    const send = iconButton("frSend", "fa-paper-plane", localize("Send"));
    const remove = iconButton("frDelete", "fa-xmark", localize("Delete"), "fr-delete");
    const move = iconButton("frMoveMenu", "fa-folder-open", localize("MoveTo"));
    controls.append(collapse, title, move, send, remove);
    controls.draggable = true;
    controls.title = localize("DragEntry");
    controls.addEventListener("dragstart", event => {
      event.stopPropagation();
      this._draggingEntry = entry.id;
      const data = JSON.stringify({ type: "FriendlyReminderEntry", id: entry.id,
        worldId: game.world.id, userId: this.store.user.id });
      event.dataTransfer.setData(ENTRY_MIME, data);
      event.dataTransfer.setData("text/plain", data);
      event.dataTransfer.effectAllowed = "move";
    });
    controls.addEventListener("dragend", () => {
      this._draggingEntry = null;
      this.clearDropHighlight();
    });
    const moveRow = document.createElement("div");
    moveRow.className = "fr-move-row";
    moveRow.hidden = true;
    const select = document.createElement("select");
    select.className = "fr-move-select";
    select.setAttribute("aria-label", localize("MoveTo"));
    for (const destination of [{ id: "", name: localize("Root") }, ...this.store.folders]) {
      const option = document.createElement("option");
      option.value = destination.id;
      option.textContent = destination.name;
      select.append(option);
    }
    select.value = this.store.folders.some(folder => folder.id === entry.folderId) ? entry.folderId : "";
    select.addEventListener("change", () => {
      select.disabled = true;
      void this.store.move(entry.id, select.value || null).catch(error => {
        select.disabled = false;
        reportError(error);
      });
    });
    moveRow.append(select);
    // A nested chat-log preserves the CSS context used by system chat cards.
    const body = document.createElement("ol");
    body.className = "fr-entry-body chat-log plain";
    body.hidden = Boolean(entry.collapsed);
    const snapshot = snapshotElement(entry.html);
    // D&D 5e can auto-collapse descriptions before a message is saved. Keep their full text accessible.
    snapshot.querySelectorAll(".description.collapsible.collapsed").forEach(node => node.classList.remove("collapsed"));
    body.append(snapshot);
    wrapper.append(controls, moveRow, body);
    return wrapper;
  }

  _replaceHTML(result, content) {
    const scrollTop = content.querySelector(".fr-scroll")?.scrollTop ?? 0;
    this.cancelDelete();
    content.replaceChildren(result);
    content.querySelector(".fr-scroll").scrollTop = scrollTop;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._listeners = new AbortController();
    const signal = this._listeners.signal;
    const minimize = iconButton("frMinimize", "fa-window-minimize", localize("Minimize"), "header-control");
    this.element.querySelector('.window-header [data-action="close"]')?.before(minimize);
    this.element.addEventListener("dragover", event => {
      const savedEntry = this.isEntryDrag(event);
      if (!savedEntry && !this.isMessageDrag?.(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = savedEntry ? "move" : "copy";
      this.clearDropHighlight();
      this.element.classList.add("fr-drag-over");
      event.target.closest(".fr-group")?.classList.add("fr-drop-target");
    }, { signal });
    this.element.addEventListener("dragleave", event => {
      if (!this.element.contains(event.relatedTarget)) this.clearDropHighlight();
    }, { signal });
    this.element.addEventListener("drop", event => {
      this.clearDropHighlight();
      const folderId = event.target.closest(".fr-group")?.dataset.folderId || null;
      if (this.isEntryDrag(event)) void this.dropEntry(event, folderId);
      else this.onDrop?.(event, folderId);
    }, { signal });
    document.addEventListener("pointerdown", event => {
      if (!event.target.closest(".fr-delete")) this.cancelDelete();
    }, { signal, capture: true });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") this.cancelDelete();
    }, { signal });
    window.addEventListener("resize", () => {
      clearTimeout(this._viewportTimer);
      this._viewportTimer = setTimeout(() => {
        if (this.rendered && !this.minimized && window.innerWidth >= 260 && window.innerHeight >= 200) {
          this.setPosition(ReminderApp.initialPosition(this.position));
        }
      }, 100);
    }, { signal });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.applyZoom();
    this.updateStatus();
    this.scheduleWindowSave();
  }

  _onClickAction(event, target) {
    const action = target.dataset.action;
    if (!action.startsWith("fr")) return;
    event.preventDefault();
    event.stopPropagation();
    const entry = this.store.entries.find(item => item.id === target.closest(".fr-entry")?.dataset.entryId);
    const folder = this.store.folders.find(item => item.id === target.closest(".fr-folder")?.dataset.folderId);
    switch (action) {
      case "frMinimize": void this.minimize(); break;
      case "frCollapse":
        if (entry) void this.store.setCollapsed(entry.id, !entry.collapsed).catch(reportError);
        break;
      case "frDelete": if (entry) this.confirmAction(target, () => this.store.remove(entry.id)); break;
      case "frSend": if (entry) void this.send(entry, target); break;
      case "frMoveMenu": {
        const row = target.closest(".fr-entry").querySelector(".fr-move-row");
        row.hidden = !row.hidden;
        if (!row.hidden) row.querySelector("select").focus();
        break;
      }
      case "frNewFolder":
        this._newFolderOpen = !this._newFolderOpen;
        this.element.querySelector(".fr-folder-create").hidden = !this._newFolderOpen;
        if (this._newFolderOpen) this.element.querySelector(".fr-folder-name").focus();
        break;
      case "frCancelFolder":
        this._newFolderOpen = false;
        this.element.querySelector(".fr-folder-create").hidden = true;
        break;
      case "frCreateFolder": void this.submitFolder(); break;
      case "frFolderCollapse":
        if (folder) void this.store.setFolderCollapsed(folder.id, !folder.collapsed).catch(reportError);
        break;
      case "frFolderKeep":
        if (folder) this.confirmAction(target, () => this.store.deleteFolder(folder.id), "ConfirmFolderKeep");
        break;
      case "frFolderDelete":
        if (folder) this.confirmAction(target, () => this.store.deleteFolder(folder.id, { deleteContents: true }), "ConfirmFolderDelete");
        break;
      case "frClearAll":
        if (this.store.entries.length) this.confirmAction(target, () => this.store.clearAll(), "ConfirmClearAll");
        break;
      case "frZoomOut": this.setZoom(this.zoom - 0.1); break;
      case "frZoomIn": this.setZoom(this.zoom + 0.1); break;
      case "frZoomReset": this.setZoom(1); break;
    }
  }

  async submitFolder() {
    const input = this.element.querySelector(".fr-folder-name");
    if (this._creatingFolder || !input.reportValidity() || !input.value.trim()) return;
    const name = input.value.trim();
    this._creatingFolder = true;
    this._newFolderOpen = false;
    this._folderDraft = "";
    try {
      await this.store.createFolder(name);
    } catch (error) {
      this._folderDraft = name;
      this._newFolderOpen = true;
      reportError(error);
      await this.render({});
    } finally { this._creatingFolder = false; }
  }

  isEntryDrag(event) {
    return Boolean(this._draggingEntry || Array.from(event.dataTransfer?.types ?? []).includes(ENTRY_MIME));
  }

  clearDropHighlight() {
    this.element?.classList.remove("fr-drag-over");
    this.element?.querySelectorAll(".fr-drop-target").forEach(node => node.classList.remove("fr-drop-target"));
  }

  async dropEntry(event, folderId) {
    event.preventDefault();
    event.stopPropagation();
    try {
      const raw = event.dataTransfer.getData(ENTRY_MIME) || event.dataTransfer.getData("text/plain");
      const data = raw ? JSON.parse(raw) : { id: this._draggingEntry, userId: this.store.user.id, worldId: game.world.id };
      if (data.userId !== this.store.user.id || data.worldId !== game.world.id) throw new Error("Invalid reminder drag");
      await this.store.move(data.id, folderId);
    } catch (error) { reportError(error); }
    finally { this._draggingEntry = null; }
  }

  confirmAction(button, task, confirmation = "ConfirmDelete") {
    if (this._deleteButton === button) {
      const pending = this._deleteTask;
      this.cancelDelete();
      button.disabled = true;
      void pending().catch(error => { button.disabled = false; reportError(error); });
      return;
    }
    this.cancelDelete();
    this._deleteButton = button;
    this._deleteTask = task;
    this._deleteRestore = { html: button.innerHTML, title: button.title, label: button.getAttribute("aria-label") };
    button.classList.add("fr-confirm");
    button.innerHTML = '<i class="fa-solid fa-check" inert></i>';
    if (button.classList.contains("fr-text-action")) button.append(document.createTextNode(localize("Confirm")));
    button.title = localize(confirmation);
    button.setAttribute("aria-label", button.title);
    this._deleteTimer = setTimeout(() => this.cancelDelete(), 5000);
  }

  cancelDelete() {
    clearTimeout(this._deleteTimer);
    if (this._deleteButton) {
      this._deleteButton.classList.remove("fr-confirm");
      this._deleteButton.innerHTML = this._deleteRestore.html;
      this._deleteButton.title = this._deleteRestore.title;
      this._deleteButton.setAttribute("aria-label", this._deleteRestore.label);
      this._deleteButton = null;
      this._deleteTask = null;
    }
  }

  async send(entry, button) {
    button.disabled = true;
    try {
      const card = snapshotElement(entry.html);
      const content = card.querySelector(".message-content")?.innerHTML || card.innerHTML;
      await ChatMessage.create(makeRepostData(entry, game.user.id, content));
      ui.notifications.info(localize("Sent"));
    } catch (error) {
      console.error("friendly-reminder |", error);
      ui.notifications.error(localize("SendError"));
    } finally { button.disabled = false; }
  }

  applyZoom() {
    this.element?.style.setProperty("--fr-zoom", this.zoom);
    const label = this.element?.querySelector(".fr-zoom");
    if (label) label.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  setZoom(zoom) {
    this.zoom = Math.round(Math.max(0.7, Math.min(1.5, zoom)) * 10) / 10;
    this.applyZoom();
    void this.store.saveWindow({ zoom: this.zoom }).catch(reportError);
  }

  updateStatus() {
    const status = this.element?.querySelector(".fr-status");
    if (!status) return;
    status.className = `fr-status fa-solid ${this.store.pending ? "fa-cloud-arrow-up" : "fa-check"}`;
    status.title = localize(this.store.pending ? "Saving" : "Synced");
    status.setAttribute("aria-label", status.title);
  }

  _onPosition(position) {
    super._onPosition(position);
    if (this.rendered) this.scheduleWindowSave();
  }

  windowData(open = true) {
    const { left, top, width, height } = this.position;
    const size = this.minimized && this._expandedSize ? this._expandedSize : { width, height };
    return { left, top, ...size, minimized: this.minimized, open };
  }

  scheduleWindowSave() {
    clearTimeout(this._positionTimer);
    this._positionTimer = setTimeout(() => {
      if (this.rendered) void this.store.saveWindow(this.windowData()).catch(reportError);
    }, 350);
  }

  async minimize() {
    if (this.minimized || !this.rendered) return;
    this._expandedSize = { width: this.position.width, height: this.position.height };
    await super.minimize();
    this.scheduleWindowSave();
  }

  async maximize() {
    const wasMinimized = this.minimized;
    await super.maximize();
    if (wasMinimized && this._expandedSize) {
      // Keep the configured size; native animated bounding boxes can be smaller mid-transition.
      this.setPosition(this._expandedSize);
      this._expandedSize = null;
    }
    this.scheduleWindowSave();
  }

  async close(options = {}) {
    clearTimeout(this._positionTimer);
    clearTimeout(this._viewportTimer);
    this.cancelDelete();
    await this.store.saveWindow(this.windowData(false)).catch(reportError);
    this._listeners?.abort();
    return super.close(options);
  }
}
