import { test } from "node:test";
import assert from "node:assert/strict";
import { ReminderStore, makeRepostData, MODULE_ID } from "../scripts/store.js";

function user(database = {}) {
  function get(path) { return path.split(".").reduce((value, key) => value?.[key], database); }
  function put(path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((object, key) => object[key] ??= {}, database);
    if (last.startsWith("-=")) delete parent[last.slice(2)];
    else if (value === undefined) delete parent[last];
    else parent[last] = structuredClone(value);
  }
  return {
    getFlag: (scope, key) => get(`flags.${scope}.${key}`),
    setFlag: async (scope, key, value) => put(`flags.${scope}.${key}`, value),
    unsetFlag: async (scope, key) => put(`flags.${scope}.${key}`, undefined),
    update: async changes => { for (const [path, value] of Object.entries(changes)) put(path, value); }
  };
}

const entry = (id, savedAt = 1) => ({ id, savedAt, html: `<li>${id}</li>`, collapsed: false });
let folderCounter = 0;
const folderStore = document => new ReminderStore(document ?? user(), { randomId: () => `folder${++folderCounter}` });

test("saved messages and window state survive a new client/store instance", async () => {
  const database = {};
  const first = new ReminderStore(user(database));
  await first.add(entry("messageA"));
  await first.saveWindow({ left: 50, top: 20, width: 310, zoom: 1.2, open: true });
  const nextSession = new ReminderStore(user(database));
  assert.equal(nextSession.entries[0].id, "messageA");
  assert.deepEqual(nextSession.windowState, { left: 50, top: 20, width: 310, zoom: 1.2, open: true });
});

test("players have independent lists", async () => {
  const alice = new ReminderStore(user());
  const bob = new ReminderStore(user());
  await alice.add(entry("aliceOnly"));
  assert.equal(bob.entries.length, 0);
});

test("the collapsed default applies to existing entries once and then preserves manual expansion", async () => {
  const database = {};
  const first = new ReminderStore(user(database));
  await first.add({ ...entry("old"), source: { content: "Full description" } });
  await first.saveWindow({ zoom: 1.2 });
  await first.initializeCollapsedDefault();
  assert.equal(first.entries[0].collapsed, true);
  assert.equal(first.entries[0].html, "<li>old</li>");
  assert.equal(first.entries[0].source.content, "Full description");
  assert.equal(first.windowState.zoom, 1.2);
  await first.setCollapsed("old", false);
  const nextSession = new ReminderStore(user(database));
  await nextSession.initializeCollapsedDefault();
  assert.equal(nextSession.entries[0].collapsed, false);
});

test("simultaneous saves and duplicate drags retain both distinct messages", async () => {
  const store = new ReminderStore(user());
  const results = await Promise.all([store.add(entry("first")), store.add(entry("second", 2)), store.add(entry("first"))]);
  assert.deepEqual(results, [true, true, false]);
  assert.deepEqual(store.entries.map(item => item.id), ["first", "second"]);
});

test("separate client instances update separate entries without replacing the list", async () => {
  const database = {};
  const a = new ReminderStore(user(database));
  const b = new ReminderStore(user(database));
  await Promise.all([a.add(entry("one")), b.add(entry("two"))]);
  await a.setCollapsed("one", true);
  await b.remove("two");
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].collapsed, true);
});

test("failed saves report failure, leave no false saved entry, and allow retry", async () => {
  const document = user();
  const set = document.setFlag;
  document.setFlag = async () => { throw new Error("Disconnected"); };
  const store = new ReminderStore(document);
  await assert.rejects(store.add(entry("retry")), /Disconnected/);
  assert.equal(store.pending, 0);
  assert.equal(store.entries.length, 0);
  document.setFlag = set;
  assert.equal(await store.add(entry("retry")), true);
});

test("collapsing a deleted entry cannot recreate an incomplete record", async () => {
  const store = new ReminderStore(user());
  await store.add(entry("gone"));
  await store.remove("gone");
  await store.setCollapsed("gone", true);
  assert.equal(store.entries.length, 0);
});

test("window moves do not replace zoom or message data", async () => {
  const database = {};
  const a = new ReminderStore(user(database));
  const b = new ReminderStore(user(database));
  await Promise.all([a.saveWindow({ zoom: 1.4 }), b.saveWindow({ left: 500, top: 60 }), a.add(entry("keep"))]);
  assert.equal(a.windowState.zoom, 1.4);
  assert.equal(a.windowState.left, 500);
  assert.equal(a.entries.length, 1);
});

test("reposts retain visuals and speaker while using the current author and no automation", () => {
  const item = { ...entry("source"), source: { alias: "Wizard", style: 2, speaker: { actor: "actorId" },
    flags: { "midi-qol": { workflow: "do-not-run" } }, rolls: ["do-not-roll"] } };
  const data = makeRepostData(item, "playerId", "<h3>Card</h3>");
  assert.equal(data.author, "playerId");
  assert.equal(data.speaker.alias, "Wizard");
  assert.equal(data.speaker.actor, "actorId");
  assert.deepEqual(data.rolls, []);
  assert.deepEqual(Object.keys(data.flags), [MODULE_ID]);
  assert.equal(data.flags[MODULE_ID].snapshot.html, item.html);
  assert.deepEqual(data.whisper, []);
});

test("reposting whispers and blind rolls never changes them to public messages", () => {
  const item = { ...entry("private"), source: { whisper: ["gmId"], blind: true } };
  const data = makeRepostData(item, "playerId", "private text");
  assert.deepEqual(data.whisper, ["gmId", "playerId"]);
  assert.equal(data.blind, true);
  assert.deepEqual(item.source.whisper, ["gmId"]);
});

test("invalid IDs cannot write arbitrary flag paths", async () => {
  const store = new ReminderStore(user());
  await assert.rejects(store.add(entry("bad.path")));
  await assert.rejects(store.remove("bad.path"));
  await assert.rejects(store.setCollapsed("bad.path", true));
});

test("legacy messages remain in root and creating folders preserves their snapshots", async () => {
  const database = { flags: { [MODULE_ID]: { entries: { old: entry("old") } } } };
  const store = folderStore(user(database));
  const folder = await store.createFolder("  Заклинания  ");
  assert.equal(folder.name, "Заклинания");
  assert.equal(store.entries[0].folderId ?? null, null);
  assert.equal(store.entries[0].html, "<li>old</li>");
  const next = folderStore(user(database));
  assert.equal(next.folders[0].id, folder.id);
});

test("messages can move between folders and root without changing their full contents", async () => {
  const store = folderStore();
  const a = await store.createFolder("A");
  const b = await store.createFolder("B");
  await store.add({ ...entry("card"), source: { content: "Full description", flags: { original: true } } }, a.id);
  await store.move("card", b.id);
  assert.equal(store.entries[0].folderId, b.id);
  await store.move("card", null);
  assert.equal(store.entries[0].folderId, null);
  assert.equal(store.entries[0].source.content, "Full description");
  assert.equal(store.entries[0].html, "<li>card</li>");
});

test("deleting a folder while keeping contents moves all its messages to root", async () => {
  const store = folderStore();
  const folder = await store.createFolder("Keep");
  await store.add(entry("a"), folder.id);
  await store.add(entry("b"), folder.id);
  await store.add(entry("root"));
  await store.deleteFolder(folder.id);
  assert.equal(store.folders.length, 0);
  assert.equal(store.entries.length, 3);
  assert.ok(store.entries.every(item => item.folderId === null));
  assert.equal(store.entries.find(item => item.id === "a").html, "<li>a</li>");
});

test("deleting a folder with contents preserves every other folder and root message", async () => {
  const store = folderStore();
  const remove = await store.createFolder("Remove");
  const keep = await store.createFolder("Keep");
  await store.add(entry("remove"), remove.id);
  await store.add(entry("keep"), keep.id);
  await store.add(entry("root"));
  await store.deleteFolder(remove.id, { deleteContents: true });
  assert.deepEqual(store.folders.map(item => item.id), [keep.id]);
  assert.deepEqual(store.entries.map(item => item.id), ["keep", "root"]);
  assert.equal(store.entries[0].folderId, keep.id);
});

test("failed folder deletion cannot partially move or remove its contents", async () => {
  const document = user();
  const store = folderStore(document);
  const folder = await store.createFolder("Keep on failure");
  await store.add(entry("preserve"), folder.id);
  document.update = async () => { throw new Error("Disconnected"); };
  await assert.rejects(store.deleteFolder(folder.id, { deleteContents: true }), /Disconnected/);
  assert.equal(store.folders.length, 1);
  assert.equal(store.entries[0].folderId, folder.id);
  assert.equal(store.entries[0].html, "<li>preserve</li>");
});

test("clear all removes records from root and folders but keeps folders, preferences and other players", async () => {
  const document = user();
  const a = folderStore(document);
  const b = folderStore();
  const folder = await a.createFolder("Empty after clear");
  await a.add(entry("inFolder"), folder.id);
  await a.add(entry("inRoot"));
  await a.setFolderCollapsed(folder.id, true);
  await a.saveWindow({ zoom: 1.3 });
  await b.add(entry("otherPlayer"));
  await a.clearAll();
  assert.equal(a.entries.length, 0);
  assert.equal(a.folders[0].collapsed, true);
  assert.equal(a.windowState.zoom, 1.3);
  assert.equal(b.entries.length, 1);
  await a.add(entry("new"), folder.id);
  assert.equal(a.entries[0].folderId, folder.id);
});

test("deleted destinations cannot lose a message or recreate a removed folder", async () => {
  const store = folderStore();
  const folder = await store.createFolder("Gone");
  await store.add(entry("moveMe"));
  await store.deleteFolder(folder.id);
  await assert.rejects(store.move("moveMe", folder.id));
  await store.add(entry("savedDuringDeletion"), folder.id);
  assert.ok(store.entries.every(item => item.folderId === null));
  assert.equal(store.folders.length, 0);
  await store.setFolderCollapsed(folder.id, true);
  assert.equal(store.folders.length, 0);
});

test("folder names are plain text and invalid folder paths are rejected", async () => {
  const store = folderStore();
  const folder = await store.createFolder('<img src=x onerror="alert(1)">');
  assert.equal(folder.name, '<img src=x onerror="alert(1)">');
  await assert.rejects(store.createFolder("   "));
  await assert.rejects(store.createFolder("a".repeat(81)));
  await assert.rejects(store.deleteFolder("bad.path"));
  await assert.rejects(store.setFolderCollapsed("bad.path", true));
  await assert.rejects(store.move("card", "bad.path"));
});
