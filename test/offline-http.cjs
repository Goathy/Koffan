// Explicit localhost integration test. Run with node test/offline-http.cjs.
// It creates a uniquely named disposable list and removes only that list.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const OfflineCRUD = require('../static/offline-crud.js');

const baseURL = new URL(process.env.KOFFAN_TEST_URL || 'http://localhost:31426');
if (!['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname)) {
    throw new Error('This disposable-data integration test only supports localhost');
}
const password = process.env.KOFFAN_TEST_PASSWORD || 'koffan-local-test-password';
const unique = `offline-http-${Date.now()}-${randomUUID().slice(0, 8)}`;
const initialName = `${unique} initial`;
const finalName = `${unique} renamed`;
let cookie;
let cleanupVerified = false;

function memoryStorage() {
    const values = new Map();
    return {
        async getMetadata(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
        async setMetadata(key, value) { values.set(key, structuredClone(value)); }
    };
}

async function authenticate() {
    const response = await fetch(new URL('/login', baseURL), {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password }),
        signal: AbortSignal.timeout(15000)
    });
    assert.ok([302, 303].includes(response.status), `Login failed with HTTP ${response.status}`);
    cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    assert.ok(cookie, 'Login did not provide a session cookie');
}

async function httpRequest(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Cookie', cookie);
    return fetch(new URL(path, baseURL), {
        ...options, headers, cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
}

async function snapshot() {
    const response = await httpRequest('/api/offline/snapshot');
    assert.equal(response.status, 200, `Snapshot request failed with HTTP ${response.status}`);
    assert.equal(response.redirected, false, 'Snapshot request redirected to login');
    const state = await response.json();
    for (const key of ['lists', 'sections', 'items']) assert.ok(Array.isArray(state[key]), `Snapshot has no ${key} array`);
    return state;
}

function ownedList(state) {
    const lists = state.lists.filter(list => list.name === initialName || list.name === finalName);
    assert.equal(lists.length, 1, 'The disposable list must exist exactly once');
    return lists[0];
}

async function cleanup() {
    if (!cookie) return;
    const before = await snapshot();
    const lists = before.lists.filter(list => list.name === initialName || list.name === finalName);
    const listIDs = new Set(lists.map(list => list.id));
    const sectionIDs = new Set(before.sections.filter(section => listIDs.has(section.list_id)).map(section => section.id));
    if (lists.length) {
        // A fresh model cannot accidentally retry unrelated failed test operations.
        const client = new OfflineCRUD({ storage: memoryStorage(), request: httpRequest });
        await client.init();
        await client.seed(before);
        for (const list of lists) await client.mutate({ entity: 'list', action: 'delete', entity_id: list.id });
        await client.sync();
        client.close();
    }
    const after = await snapshot();
    assert.equal(after.lists.some(list => list.name === initialName || list.name === finalName), false, 'Disposable list cleanup failed');
    assert.equal(after.sections.some(section => listIDs.has(section.list_id)), false, 'Disposable sections survived list cleanup');
    assert.equal(after.items.some(item => sectionIDs.has(item.section_id)), false, 'Disposable items survived list cleanup');
    cleanupVerified = true;
}

async function run() {
    await authenticate();
    const initial = await snapshot();
    const initialActiveIDs = initial.lists.filter(list => list.is_active).map(list => list.id);
    const storage = memoryStorage();
    let offline = true;
    let loseNextAcknowledgement = false;
    const sentBodies = [];
    const request = async (path, options = {}) => {
        if (offline) throw new TypeError('Simulated offline connection');
        if (path === '/api/offline/sync') sentBodies.push(options.body);
        const response = await httpRequest(path, options);
        if (loseNextAcknowledgement && path === '/api/offline/sync' && response.ok && !response.redirected) {
            // The server has committed and the full response has arrived, but the
            // caller loses that acknowledgement just before durable queue removal.
            const committed = await response.json();
            assert.ok(committed.results.length > 0, 'Successful sync did not acknowledge operations');
            loseNextAcknowledgement = false;
            throw new TypeError('Simulated lost acknowledgement after server commit');
        }
        return response;
    };
    let client = new OfflineCRUD({ storage, request });
    await client.init();
    await client.seed(initial);
    const list = await client.mutate({ entity: 'list', action: 'create', values: { name: initialName, is_active: false } });
    const firstSection = await client.mutate({ entity: 'section', action: 'create', values: { list_id: list.entity_id, name: 'Pantry' } });
    const secondSection = await client.mutate({ entity: 'section', action: 'create', values: { list_id: list.entity_id, name: 'Produce' } });
    const item = await client.mutate({ entity: 'item', action: 'create', values: { section_id: firstSection.entity_id, name: 'Bread' } });
    const removedItem = await client.mutate({ entity: 'item', action: 'create', values: { section_id: firstSection.entity_id, name: 'Remove this item' } });
    const removedSection = await client.mutate({ entity: 'section', action: 'create', values: { list_id: list.entity_id, name: 'Remove this section' } });
    await client.mutate({ entity: 'item', action: 'create', values: { section_id: removedSection.entity_id, name: 'Cascade removal' } });
    const originalClientID = client.clientId;
    const originalOperations = client.getPendingOperations();
    await assert.rejects(client.sync(), /Simulated offline/);
    assert.deepEqual(client.getPendingOperations(), originalOperations);
    client.close();

    client = new OfflineCRUD({ storage, request });
    await client.init();
    assert.equal(client.clientId, originalClientID);
    assert.deepEqual(client.getPendingOperations(), originalOperations);
    await client.mutate({ entity: 'list', action: 'update', entity_id: list.entity_id, values: { name: finalName, icon: '🧪', show_completed: false } });
    await client.mutate({ entity: 'section', action: 'update', entity_id: firstSection.entity_id, values: { name: 'Renamed pantry', sort_mode: 'alphabetical', sort_order: 2 } });
    await client.mutate({ entity: 'section', action: 'update', entity_id: secondSection.entity_id, values: { sort_order: 1 } });
    await client.mutate({ entity: 'item', action: 'update', entity_id: item.entity_id, values: { name: 'Wholemeal bread', description: 'Integration test', quantity: 4, uncertain: true, completed: true } });
    await client.mutate({ entity: 'item', action: 'update', entity_id: item.entity_id, values: { completed: false } });
    await client.mutate({ entity: 'item', action: 'update', entity_id: item.entity_id, values: { completed: true, section_id: secondSection.entity_id } });
    await client.mutate({ entity: 'item', action: 'delete', entity_id: removedItem.entity_id });
    await client.mutate({ entity: 'section', action: 'delete', entity_id: removedSection.entity_id });
    assert.equal(client.getState().items.filter(value => [firstSection.entity_id, secondSection.entity_id, removedSection.entity_id].includes(value.section_id)).length, 1);

    offline = false;
    loseNextAcknowledgement = true;
    const pendingBeforeLostACK = client.getPendingOperations();
    await assert.rejects(client.sync(), /Simulated lost acknowledgement/);
    assert.deepEqual(client.getPendingOperations(), pendingBeforeLostACK);
    const committedState = await snapshot();
    const serverList = ownedList(committedState);
    assert.equal(serverList.icon, '🧪');
    assert.equal(serverList.show_completed, false);
    assert.deepEqual(committedState.lists.filter(value => value.is_active).map(value => value.id), initialActiveIDs, 'Creating an inactive list changed another list active state');
    client.close();

    client = new OfflineCRUD({ storage, request });
    await client.init();
    await client.sync();
    assert.equal(sentBodies[1], sentBodies[0], 'Lost acknowledgement retry changed its operation payload');
    assert.equal(client.pendingCount, 0);
    assert.equal(client.resolveID('list', list.entity_id), serverList.id);
    const afterRetry = await snapshot();
    ownedList(afterRetry);
    const sections = afterRetry.sections.filter(section => section.list_id === serverList.id);
    assert.equal(sections.length, 2);
    const serverFirst = sections.find(section => section.name === 'Renamed pantry');
    const serverSecond = sections.find(section => section.name === 'Produce');
    assert.ok(serverFirst && serverSecond, 'Expected renamed and destination sections');
    assert.equal(serverFirst.sort_mode, 'alphabetical');
    assert.equal(serverFirst.sort_order, 2);
    assert.equal(serverSecond.sort_order, 1);
    const sectionIDs = new Set(sections.map(section => section.id));
    const items = afterRetry.items.filter(value => sectionIDs.has(value.section_id));
    assert.equal(items.length, 1, 'Lost acknowledgement retry duplicated items or deletion failed');
    assert.equal(items[0].name, 'Wholemeal bread');
    assert.equal(items[0].description, 'Integration test');
    assert.equal(items[0].quantity, 4);
    assert.equal(items[0].uncertain, true);
    assert.equal(items[0].completed, true);
    assert.equal(items[0].section_id, serverSecond.id);

    // Perform a second offline period using both resolved IDs and old temporary
    // handles retained by the UI. The model must remap the old handles safely.
    offline = true;
    await client.mutate({ entity: 'item', action: 'update', entity_id: item.entity_id, values: { section_id: firstSection.entity_id, completed: false, quantity: 7, uncertain: false } });
    await client.mutate({ entity: 'section', action: 'delete', entity_id: serverSecond.id });
    offline = false;
    await client.sync();
    const final = await snapshot();
    const finalSections = final.sections.filter(section => section.list_id === serverList.id);
    assert.equal(finalSections.length, 1);
    assert.equal(finalSections[0].id, serverFirst.id);
    const finalItem = final.items.find(value => value.id === items[0].id);
    assert.ok(finalItem, 'Moving before deleting the source section removed the item');
    assert.equal(finalItem.section_id, serverFirst.id);
    assert.equal(finalItem.completed, false);
    assert.equal(finalItem.quantity, 7);
    assert.equal(finalItem.uncertain, false);
    assert.equal(client.pendingCount, 0);
    client.close();
}

(async () => {
    let failure;
    try { await run(); } catch (cause) { failure = cause; }
    try { await cleanup(); } catch (cause) {
        failure ||= cause;
        console.error(`Cleanup failed: ${cause.message}`);
    }
    if (failure) {
        console.error(`Offline CRUD HTTP integration failed: ${failure.message}`);
        if (cleanupVerified) console.error('Disposable test data cleanup verified.');
        process.exitCode = 1;
    } else {
        console.log('Offline CRUD HTTP integration passed: offline CRUD, reload, FIFO replay, lost ACK, ID remapping, cascading deletion and cleanup.');
    }
})();
