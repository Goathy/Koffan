const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadStorage(indexedDB = {}) {
    const context = vm.createContext({ window: {}, indexedDB, console });
    vm.runInContext(fs.readFileSync(require.resolve('../static/offline-storage.js'), 'utf8'), context);
    return context.window.offlineStorage;
}

function writeFixture() {
    const storage = loadStorage();
    const request = { result: 42 };
    let written;
    const store = {
        add(value) { written = value; return request; },
        delete() { return request; },
        clear() { return request; },
        put() { return request; }
    };
    const tx = { objectStore: () => store };
    storage.db = { transaction: () => tx };
    return { storage, tx, request, written: () => written };
}

for (const method of ['queueAction', 'clearAction', 'clearAllActions', 'setMetadata']) {
    test(`${method} waits for transaction commit before confirming persistence`, async () => {
        const { storage, tx, request } = writeFixture();
        let settled = false;
        const result = storage[method]({ type: 'toggle_item' }).then(value => { settled = true; return value; });
        request.onsuccess?.();
        await Promise.resolve();
        assert.equal(settled, false, 'request success is not a durable transaction commit');
        tx.oncomplete();
        assert.equal(await result, method === 'queueAction' ? 42 : undefined);
    });

    test(`${method} reports an abort after request success`, async () => {
        const { storage, tx, request } = writeFixture();
        const result = storage[method]({ type: 'toggle_item' });
        request.onsuccess?.();
        tx.error = new Error('Storage quota exceeded');
        tx.onabort();
        await assert.rejects(result, /Storage quota exceeded/);
    });
}

test('queued action preserves the original tap timestamp', async () => {
    const { storage, tx, written } = writeFixture();
    const result = storage.queueAction({ type: 'toggle_item', timestamp: 1700000000 });
    tx.oncomplete();
    await result;
    assert.equal(written().timestamp, 1700000000);
});

test('simultaneous initialization opens one database and reconnects after closure', async () => {
    let opens = 0;
    const request = {};
    const storage = loadStorage({ open() { opens++; return request; } });
    const first = storage.init();
    const second = storage.init();
    const db = { close() {} };
    request.result = db;
    request.onsuccess();
    assert.equal(await first, db);
    assert.equal(await second, db);
    assert.equal(opens, 1);
    db.onclose();
    assert.equal(storage.db, null);
    const reopened = storage.init();
    request.onsuccess();
    await reopened;
    assert.equal(opens, 2);
});

for (const remove of [false, true]) {
    test(`${remove ? 'removing' : 'updating'} a cached item reads and writes in one transaction`, async () => {
        const storage = loadStorage();
        let transactions = 0;
        let written;
        const request = { result: [{ id: 1, items: [{ id: 10, completed: false }, { id: 11, completed: false }] }] };
        const tx = { objectStore: () => ({ getAll: () => request, put(value) { written = value; } }) };
        storage.db = { transaction(name, mode) {
            transactions++;
            assert.equal(name, 'sections');
            assert.equal(mode, 'readwrite');
            return tx;
        } };
        const result = remove ? storage.removeItemFromCache(10) : storage.updateItemInCache(10, { completed: true });
        request.onsuccess();
        assert.equal(transactions, 1);
        assert.equal(written.items.length, remove ? 1 : 2);
        assert.equal(written.items.find(item => item.id === 11).completed, false);
        if (!remove) assert.equal(written.items[0].completed, true);
        tx.oncomplete();
        assert.equal(await result, true);
    });
}

function sectionsFixture(initial) {
    const storage = loadStorage();
    const records = new Map(initial.map(section => [section.id, structuredClone(section)]));
    let request;
    let tx;
    storage.db = { transaction(name, mode) {
        assert.equal(name, 'sections');
        assert.equal(mode, 'readwrite');
        request = undefined;
        tx = { objectStore: () => ({
            getAll() { request = { result: [...records.values()].map(section => structuredClone(section)) }; return request; },
            clear() { records.clear(); },
            delete(id) { records.delete(id); },
            add(section) { records.set(section.id, structuredClone(section)); },
            put(section) { records.set(section.id, structuredClone(section)); }
        }) };
        return tx;
    } };
    return { storage, records, commit() { request?.onsuccess(); tx.oncomplete(); } };
}

test('refreshing one list preserves cached sections from other lists and removes obsolete sections', async () => {
    const { storage, records, commit } = sectionsFixture([
        { id: 1, list_id: 10, items: [{ id: 7, completed: true }] },
        { id: 2, list_id: 20, items: [{ id: 8, completed: true }] },
        { id: 3, list_id: 10, items: [] }
    ]);
    const saved = storage.saveSections([{ id: 1, list_id: 10, items: [{ id: 7, completed: false }] }], '10');
    commit();
    await saved;
    assert.equal(records.size, 2);
    assert.equal(records.get(1).items[0].completed, false);
    assert.equal(records.get(2).items[0].completed, true);
    assert.equal(records.has(3), false, 'a section removed from this list is evicted');
});

test('an empty list refresh does not erase another list offline cache', async () => {
    const { storage, records, commit } = sectionsFixture([
        { id: 1, list_id: 10, items: [] },
        { id: 2, list_id: 20, items: [] }
    ]);
    const saved = storage.saveSections([], 10);
    commit();
    await saved;
    assert.deepEqual([...records.keys()], [2]);
});

test('saving sections without a list scope preserves the legacy complete replacement behavior', async () => {
    const { storage, records, commit } = sectionsFixture([{ id: 1, list_id: 10, items: [] }]);
    const saved = storage.saveSections([{ id: 2, list_id: 20, items: [] }]);
    commit();
    await saved;
    assert.deepEqual([...records.keys()], [2]);
});
