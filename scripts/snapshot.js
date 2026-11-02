import { MODULE_ID, FLAG_VERSION } from "./store.js";

const REMOVED = "script, iframe, object, embed, link, meta, base, style, "
  + ".message-delete, .message-dismiss, .message-metadata .chat-control, .fr-save-button, .fr-entry-controls";

/** Only local asset URLs are rebased; external media keep their original addresses. */
function portableURL(value, baseURI) {
  if (!value || value.startsWith("#")) return value;
  try {
    const base = new URL(baseURI);
    const url = new URL(value, base);
    if (!["http:", "https:", "data:", "mailto:", "tel:"].includes(url.protocol)) return "";
    if (url.protocol === "data:" && !/^data:image\//i.test(value)) return "";
    if (url.origin === base.origin) return `${url.pathname}${url.search}${url.hash}`;
    return value;
  } catch { return ""; }
}

export function cleanSnapshot(html, baseURI = document.baseURI) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll(REMOVED).forEach(node => node.remove());
  parsed.querySelectorAll("form").forEach(node => node.replaceWith(...node.childNodes));
  const root = parsed.body.firstElementChild;
  if (!root) throw new Error("Empty chat snapshot");
  const card = parsed.createElement("li");
  // Keep system and module classes, headers, artwork, inline styling and the entire message content.
  for (const attr of root.attributes) card.setAttribute(attr.name, attr.value);
  card.append(...root.childNodes);
  card.classList.add("chat-message", "message", "flexcol");
  card.classList.remove("fr-snapshot", "fr-dragging");
  for (const node of [card, ...card.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name === "data-action" && attr.value === "expandRoll") node.dataset.frExpandRoll = "true";
      if (name.startsWith("on") || ["id", "data-action", "data-message-id", "srcdoc", "is", "autoplay",
        "draggable", "contenteditable", "formaction", "srcset"].includes(name)) node.removeAttribute(attr.name);
      else if (["href", "src", "poster", "xlink:href"].includes(name)) {
        const value = portableURL(attr.value, baseURI);
        if (value) node.setAttribute(attr.name, value);
        else node.removeAttribute(attr.name);
      } else if (name === "style") {
        node.setAttribute("style", attr.value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
          (_match, _quote, url) => `url("${portableURL(url, baseURI).replaceAll('"', '%22')}")`));
      }
    }
    // The snapshot is a reminder, so its original action buttons must not spend resources or roll dice.
    if (node.matches("button, input, select, textarea")) node.setAttribute("disabled", "");
  }
  return card.outerHTML;
}

export function snapshotElement(html) {
  const template = document.createElement("template");
  template.innerHTML = cleanSnapshot(html);
  const card = template.content.firstElementChild;
  card.classList.add("fr-snapshot");
  activateSnapshotInteractions(card);
  return card;
}

const interactive = new WeakSet();

/** Restore presentation-only interactions without restoring source document actions. */
export function activateSnapshotInteractions(card) {
  if (interactive.has(card)) return;
  interactive.add(card);
  card.addEventListener("click", event => {
    const roll = event.target.closest("[data-fr-expand-roll]");
    if (roll) {
      roll.classList.toggle("expanded");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const description = event.target.closest(".description.collapsible");
    if (description && !event.target.closest(".collapsible-content, a, button, input")) {
      description.classList.toggle("collapsed");
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

export function snapshotTitle(card) {
  const heading = [".card-header h3", ".card-header h2", ".card-header .title", ".item-name", ".item-title", ".flavor-text",
    ".message-content h1", ".message-content h2", ".message-content h3", ".message-sender"]
    .map(selector => card.querySelector(selector)).find(Boolean);
  return (heading?.textContent
    || card.querySelector(".message-content")?.textContent || card.textContent || "")
    .replace(/\s+/g, " ").trim().slice(0, 150);
}

export async function captureMessage(message, element) {
  if (!message?.visible || !message.isContentVisible) throw new Error("Message content is not visible");
  const repost = message.getFlag(MODULE_ID, "snapshot");
  const original = element ?? await message.renderHTML({ canDelete: false, canClose: false });
  const html = cleanSnapshot(original.outerHTML);
  const card = snapshotElement(html);
  const source = message.toObject();
  // Re-saving a repost must not recursively nest previous snapshots in the stored source data.
  if (source.flags) delete source.flags[MODULE_ID];
  return {
    version: FLAG_VERSION,
    id: repost?.originId ?? message.id,
    sourceId: message.id,
    savedAt: Date.now(),
    collapsed: true,
    title: snapshotTitle(card),
    html,
    source: {
      ...source,
      alias: message.alias
    }
  };
}

export function restoreRepost(message, element) {
  const snapshot = message.getFlag(MODULE_ID, "snapshot");
  if (!snapshot?.html || !message.visible || !message.isContentVisible) return;
  const card = snapshotElement(snapshot.html);
  element.className = card.className;
  if (card.hasAttribute("style")) element.setAttribute("style", card.getAttribute("style"));
  element.replaceChildren(...card.childNodes);
  activateSnapshotInteractions(element);
  element.dataset.messageId = message.id;
  if (game.user.isGM) {
    const remove = document.createElement("a");
    remove.className = "message-delete";
    remove.dataset.action = "deleteMessage";
    remove.setAttribute("aria-label", game.i18n.localize("Delete"));
    remove.innerHTML = '<i class="fa-solid fa-trash" inert></i>';
    element.querySelector(".message-metadata")?.append(remove);
  }
}
