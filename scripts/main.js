import { MODULE_ID, ReminderStore, localize, reportError } from "./store.js";
import { captureMessage, restoreRepost } from "./snapshot.js";
import { ReminderApp, iconButton } from "./app.js";

const MIME = "application/x-friendly-reminder";
const decorated = new WeakSet();
let store;
let app;
let launcher;
let draggingMessage = null;

const asElement = html => html instanceof HTMLElement ? html : html?.[0];
const visible = message => Boolean(message?.visible && message.isContentVisible);
const messageFromElement = element => game.messages.get(asElement(element)?.closest("[data-message-id]")?.dataset.messageId);

async function saveMessage(message, element, folderId = null) {
  if (!store || !visible(message)) return;
  try {
    const saved = await store.add(await captureMessage(message, element), folderId);
    ui.notifications.info(localize(saved ? "Saved" : "AlreadySaved"));
    await app.show();
  } catch (error) { reportError(error); }
}

function decorateMessage(message, element) {
  if (!element || !visible(message)) return;
  if (!decorated.has(element)) {
    decorated.add(element);
    element.draggable = true;
    element.addEventListener("dragstart", event => {
      // Preserve dragging items and content links supplied by the system.
      if (event.target !== element && event.target.closest("a, button, input, [draggable='true']") !== element) return;
      draggingMessage = message.id;
      const data = { type: "ChatMessage", uuid: message.uuid, id: message.id, worldId: game.world.id };
      event.dataTransfer.setData(MIME, JSON.stringify(data));
      if (!event.dataTransfer.getData("text/plain")) event.dataTransfer.setData("text/plain", JSON.stringify(data));
      event.dataTransfer.effectAllowed = "copy";
    });
    element.addEventListener("dragend", () => { draggingMessage = null; });
  }
  if (element.querySelector(".fr-save-button")) return;
  const save = iconButton(null, "fa-bookmark", localize("Save"), "fr-save-button");
  save.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    void saveMessage(message, element);
  });
  element.querySelector(".message-metadata")?.prepend(save);
}

function isMessageDrag(event) {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return Boolean(draggingMessage || types.includes(MIME) || types.includes("text/plain"));
}

async function dropMessage(event, folderId = null) {
  if (!isMessageDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    const raw = event.dataTransfer.getData(MIME) || event.dataTransfer.getData("text/plain");
    const data = raw ? JSON.parse(raw) : { id: draggingMessage, type: "ChatMessage" };
    if (data.type !== "ChatMessage" || (data.worldId && data.worldId !== game.world.id)) throw new Error("Invalid message drop");
    const id = data.id || /^ChatMessage\.([\w-]+)$/.exec(data.uuid)?.[1];
    const message = game.messages.get(id);
    if (!visible(message)) throw new Error("Message is not visible");
    const element = [...document.querySelectorAll(".chat-log > .message[data-message-id]")]
      .find(node => node.dataset.messageId === id);
    await saveMessage(message, element, folderId);
  } catch { ui.notifications.warn(localize("InvalidDrop")); }
  finally { draggingMessage = null; }
}

function installLauncher() {
  const controls = document.getElementById("chat-controls");
  const input = document.getElementById("chat-message");
  if (!controls && !input?.parentElement) return;
  // Theatre owns the lower row above the input; keep its three left-hand buttons together.
  let row = input?.parentElement?.querySelector(":scope > .theatre-control-button-bar");
  if (!row) {
    const parent = controls ?? input.parentElement;
    row = parent.querySelector(":scope > .fr-launcher-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "fr-launcher-row";
      if (controls) controls.append(row);
      else input.before(row);
    }
  }
  row.classList.add("fr-launcher-host");
  if (!launcher) {
    launcher = iconButton(null, "fa-bookmark", localize("Open"), "fr-launcher ui-control icon");
    launcher.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void app.show().catch(reportError);
    });
    launcher.addEventListener("dragover", event => {
      if (!isMessageDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      launcher.classList.add("fr-drag-over");
    });
    launcher.addEventListener("dragleave", () => launcher.classList.remove("fr-drag-over"));
    launcher.addEventListener("drop", event => {
      launcher.classList.remove("fr-drag-over");
      void dropMessage(event);
    });
  }
  if (launcher.parentElement !== row) row.append(launcher);
  // Discard unbound copies if another UI module rebuilt its toolbar from a DOM clone.
  for (const duplicate of document.querySelectorAll(".fr-launcher")) {
    if (duplicate !== launcher) duplicate.remove();
  }
  for (const previous of document.querySelectorAll(".fr-launcher-host")) {
    if (previous !== row) {
      previous.classList.remove("fr-launcher-host");
      if (previous.classList.contains("fr-launcher-row") && !previous.children.length) previous.remove();
    }
  }
}

function finalizeMessage(message, html) {
  // Run after other synchronous render hooks, to capture their headers and artwork as well.
  queueMicrotask(() => {
    const element = asElement(html);
    if (!element) return;
    restoreRepost(message, element);
    decorateMessage(message, element);
  });
}

Hooks.on("renderChatMessageHTML", finalizeMessage);
// D&D 5e performs additional asynchronous rendering after the core render hook.
Hooks.on("dnd5e.renderChatMessage", finalizeMessage);

Hooks.on("getChatMessageContextOptions", (_application, options) => {
  options.push({
    name: "FR.Save",
    icon: '<i class="fa-solid fa-bookmark"></i>',
    condition: element => visible(messageFromElement(element)),
    callback: element => saveMessage(messageFromElement(element), asElement(element))
  });
});

for (const hook of ["renderChatInput", "renderChatLog", "renderChatLog5e"]) {
  Hooks.on(hook, () => { if (app) queueMicrotask(installLauncher); });
}

Hooks.on("updateUser", (user, changes) => {
  if (!store || user.id !== store.user.id) return;
  const scope = changes.flags?.[MODULE_ID];
  if (!scope || !Object.keys(scope).some(key => /^(?:-=)?(?:entries|folders)(?:\.|$)/.test(key))) return;
  if (app.rendered) void app.render({}).catch(reportError);
});

Hooks.once("ready", async () => {
  store = new ReminderStore(game.user);
  app = new ReminderApp(store, { onDrop: dropMessage });
  app.isMessageDrag = isMessageDrag;
  game.modules.get(MODULE_ID).api = Object.freeze({
    open: () => app.show(),
    save: id => saveMessage(game.messages.get(id)),
    app
  });
  installLauncher();
  for (const element of document.querySelectorAll(".chat-log > .message[data-message-id]")) {
    const message = game.messages.get(element.dataset.messageId);
    if (message) decorateMessage(message, element);
  }
  // UI modules can move or rebuild the input controls after the standard chat hook.
  new MutationObserver(installLauncher)
    .observe(document.body, { childList: true, subtree: true });
  await store.initializeCollapsedDefault().catch(reportError);
  if (store.windowState.open) void app.show({ restore: true }).catch(reportError);
  console.info("Friendly reminder | Ready");
});
