const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function loadApp({ elements = {}, actions = [], sections = [] } = {}) {
    const timers = new Map();
    let nextTimer = 0;
    let nextAction = Math.max(0, ...actions.map(action => action.id || 0));
    const queued = actions.map(action => ({ ...action }));
    const cleared = [];
    const document = {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {},
        getElementById: id => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        body: { addEventListener() {} }
    };
    const window = {
        addEventListener() {}, removeEventListener() {},
        location: { protocol: 'http:', host: 'localhost:3000', pathname: '/lists/1' },
        offlineStorage: {
            async getSections() { return sections; },
            async queueAction(action) {
                const id = ++nextAction;
                queued.push({ ...action, id });
                return id;
            },
            async getQueuedActions() { return queued.map(action => ({ ...action })); },
            async clearAction(id) {
                cleared.push(id);
                const index = queued.findIndex(action => action.id === id);
                if (index !== -1) queued.splice(index, 1);
            }
        }
    };
    const context = vm.createContext({
        window, document, navigator: { onLine: true }, localStorage: { getItem: () => null },
        console: { log() {}, warn() {}, error() {} },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        URLSearchParams, AbortController,
        Alpine: { destroyTree() {} },
        t: key => key
    });
    vm.runInContext(fs.readFileSync(require.resolve('../static/app.js'), 'utf8'), context);
    const app = context.shoppingList();
    app.$nextTick = callback => callback();
    app.initMobileSortable = () => {};
    app._applyOfflineToggle = async () => {};
    return { app, queued, cleared, timers, context };
}

test('a tap queued during foreground refresh schedules retry and is sent after that refresh', async () => {
    const { app, queued, cleared, timers } = loadApp();
    app.offlineStorageReady = true;
    const refreshing = deferred();
    const release = deferred();
    let refreshes = 0;
    const sent = [];
    app.refreshSectionsSmooth = async () => {
        if (++refreshes === 1) { refreshing.resolve(); await release.promise; }
    };
    app.refreshStats = () => {};
    app.cacheData = async () => {};
    app.request = async (_url, options) => {
        sent.push(options.body);
        return { ok: true, status: 200 };
    };
    const foreground = app.fullRefresh();
    await refreshing.promise;
    await app.queueOfflineAction(toggleAction(undefined, true));
    assert.ok([...timers.values()].some(timer => timer.delay === 5000), 'every persisted tap has a retry even if a refresh is already running');
    const tapRefresh = app.fullRefresh();
    release.resolve();
    await Promise.all([foreground, tapRefresh]);
    if (!sent.length) {
        const retry = [...timers.values()].find(timer => timer.delay === 5000);
        retry.callback();
        await app._fullRefreshPromise;
    }
    assert.deepEqual(sent, ['completed=true']);
    assert.equal(queued.length, 0);
    assert.deepEqual(cleared, [1]);
});

test('a retry firing during a slow refresh cannot strand a newly queued tap', async () => {
    const { app, queued, timers } = loadApp();
    app.offlineStorageReady = true;
    const refreshing = deferred();
    const release = deferred();
    let refreshes = 0;
    const sent = [];
    app.refreshSectionsSmooth = async () => {
        if (++refreshes === 1) { refreshing.resolve(); await release.promise; }
    };
    app.refreshStats = () => {};
    app.cacheData = async () => {};
    app.request = async (_url, options) => {
        sent.push(options.body);
        return { ok: true, status: 200 };
    };
    const foreground = app.fullRefresh();
    await refreshing.promise;
    await app.queueOfflineAction(toggleAction(undefined, true));
    const [timerId, retry] = [...timers.entries()].find(([, timer]) => timer.delay === 5000);
    timers.delete(timerId);
    retry.callback();
    await Promise.resolve();
    release.resolve();
    await foreground;
    if (!sent.length) {
        const nextRetry = [...timers.values()].find(timer => timer.delay === 5000);
        assert.ok(nextRetry, 'finishing the slow refresh must rearm retry for remaining work');
        nextRetry.callback();
        await app._fullRefreshPromise;
    }
    assert.deepEqual(sent, ['completed=true']);
    assert.equal(queued.length, 0);
});

test('request timeout also aborts a response whose headers arrive but body stalls', async () => {
    const { app, context, timers } = loadApp();
    const reading = deferred();
    let signal;
    context.fetch = async (_url, options) => {
        signal = options.signal;
        return {
            ok: true, status: 200,
            text() {
                reading.resolve();
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('Body aborted')), { once: true });
                });
            }
        };
    };
    const request = app.request('/sections/2/html');
    await reading.promise;
    const timeout = [...timers.values()].find(timer => timer.delay === 8000);
    assert.ok(timeout, 'timeout stays active after response headers arrive');
    timeout.callback();
    await assert.rejects(request, /Body aborted/);
    assert.equal(signal.aborted, true);
    assert.equal(app.isOnline, false);
    assert.equal(timers.size, 0);
});

test('an unreachable server on cold reload restores cached completions before pending tap intentions', async () => {
    const { app, queued, context } = loadApp({
        actions: [toggleAction(1, true)],
        sections: [{ id: 2, items: [{ id: 7, completed: false }, { id: 8, completed: true }] }]
    });
    app.offlineStorageReady = true;
    const applied = [];
    const visible = new Map([['7', false], ['8', false]]);
    app._applyOfflineToggle = async (itemId, _sectionId, completed, pending = true) => {
        applied.push({ id: String(itemId), completed, pending });
        visible.set(String(itemId), completed);
    };
    app.request = async () => { throw new TypeError('Server unreachable'); };
    assert.equal(context.navigator.onLine, true, 'the browser still reports network connectivity');
    await app.processOfflineQueue();
    assert.deepEqual(applied, [
        { id: '7', completed: false, pending: false },
        { id: '8', completed: true, pending: false },
        { id: '7', completed: true, pending: true }
    ]);
    assert.equal(visible.get('8'), true, 'already synchronized completion survives stale HTML');
    assert.equal(visible.get('7'), true, 'the pending tap overrides the older cached completion');
    assert.equal(queued.length, 1);
    assert.equal(app._pendingCompletions['7'], true);
});

test('cache hydration failure still restores pending intentions and leaves sync retryable', async () => {
    const { app, queued, context, timers } = loadApp({ actions: [toggleAction(1, true)] });
    app.offlineStorageReady = true;
    context.window.offlineStorage.getSections = async () => { throw new Error('Cache unavailable'); };
    app.request = async () => { throw new TypeError('Server unreachable'); };
    const applied = [];
    app._applyOfflineToggle = async (itemId, _sectionId, completed) => applied.push([String(itemId), completed]);
    await assert.doesNotReject(() => app.processOfflineQueue());
    assert.deepEqual(applied, [['7', true]]);
    assert.equal(queued.length, 1);
    assert.equal(app.processingQueue, false);
    assert.equal(app._queuePromise, null);
    assert.ok([...timers.values()].some(timer => timer.delay === 5000));
});

test('failure to update optional item cache does not roll back a durably queued tap', async () => {
    function classes(...initial) {
        const values = new Set(initial);
        return {
            contains: name => values.has(name),
            add: (...names) => names.forEach(name => values.add(name)),
            remove: (...names) => names.forEach(name => values.delete(name)),
            toggle(name, force) {
                const present = force === undefined ? !values.has(name) : force;
                if (present) values.add(name); else values.delete(name);
                return present;
            }
        };
    }
    const checkbox = { classList: classes('border-2', 'border-stone-300'), innerHTML: '' };
    const name = { classList: classes('text-stone-700') };
    const item = {
        dataset: {}, classList: classes(),
        querySelector(selector) {
            if (selector === 'button > span') return checkbox;
            if (selector === 'button') return { setAttribute() {} };
            if (selector === '.item-name') return name;
            if (selector === '.offline-sync-badge') return { remove() {} };
            if (selector === '.text-stone-700') return name.classList.contains('text-stone-700') ? name : null;
            if (selector === '.line-through') return name.classList.contains('line-through') ? name : null;
            return null;
        }
    };
    const { app, context, queued } = loadApp({ elements: { 'item-7': item } });
    app._applyOfflineToggle = context.shoppingList()._applyOfflineToggle;
    app.offlineStorageReady = true;
    context.navigator.onLine = false;
    app.isOnline = false;
    app.stats = { total: 2, completed: 0, percentage: 0 };
    let cacheWrites = 0;
    context.window.offlineStorage.updateItemInCache = async () => {
        cacheWrites++;
        throw new Error('Cache transaction failed');
    };
    await app.toggleItem(7, 2);
    assert.equal(cacheWrites, 1);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].body, 'completed=true');
    assert.equal(checkbox.classList.contains('bg-pink-400'), true);
    assert.equal(item.dataset.pendingSync, 'true');
    assert.equal(app.stats.completed, 1);
    assert.equal(app._pendingCompletions[7], true);
    assert.equal(app._toggleInFlight[7], undefined);
});

test('a local create response cannot duplicate the row already inserted by its realtime event', () => {
    const elements = {};
    const { app } = loadApp({ elements });
    const inserted = [];
    const container = {
        insertAdjacentHTML(position, html) {
            inserted.push({ position, html });
            const id = html.match(/id=["'](item-\d+)["']/)?.[1];
            if (id) elements[id] = { id };
        }
    };
    const firstItem = '<div id="item-7">Milk</div>';
    app.insertItemHTML(container, firstItem);
    app.insertItemHTML(container, firstItem);
    app.insertItemHTML(container, '<div id="item-8">Bread</div>', 'afterbegin');
    assert.deepEqual(inserted, [
        { position: 'beforeend', html: firstItem },
        { position: 'afterbegin', html: '<div id="item-8">Bread</div>' }
    ]);
});

function toggleAction(id, completed) {
    return {
        id, type: 'toggle_item', url: '/items/7/toggle', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `completed=${completed}`, completed, sectionId: 2, timestamp: 1700000000
    };
}

test('another shopper completion is applied even immediately after a local toggle', () => {
    const { app } = loadApp();
    const changes = [];
    app.toggleRemoteItem = (...args) => changes.push(args);
    app.refreshStats = () => {};
    app.markLocalAction('item_toggled');
    app.handleMessage(JSON.stringify({ type: 'item_toggled', data: { id: 8, section_id: 2, completed: true } }));
    assert.deepEqual(changes, [[8, 2, true]]);
});

test('remote events received while changes are pending request later reconciliation', () => {
    const { app } = loadApp();
    let toggled = false;
    app._pendingActionCount = 1;
    app.toggleRemoteItem = () => { toggled = true; };
    app.handleMessage(JSON.stringify({ type: 'item_toggled', data: { id: 8, section_id: 2, completed: true } }));
    assert.equal(toggled, false);
    assert.equal(app._needsRefresh, true);
});

test('simultaneous foreground refresh calls both await the actual list refresh', async () => {
    const { app } = loadApp();
    const refresh = deferred();
    const started = deferred();
    let refreshes = 0;
    let cached = false;
    let firstDone = false;
    let secondDone = false;
    app.processOfflineQueue = async () => false;
    app.refreshList = () => { refreshes++; started.resolve(); return refresh.promise; };
    app.refreshStats = () => {};
    app.cacheData = async () => { cached = true; };
    const first = app.fullRefresh().then(() => { firstDone = true; });
    const second = app.fullRefresh().then(() => { secondDone = true; });
    await started.promise;
    await Promise.resolve();
    assert.equal(refreshes, 1);
    assert.equal(firstDone, false);
    assert.equal(secondDone, false);
    assert.equal(cached, false);
    refresh.resolve();
    await Promise.all([first, second]);
    assert.equal(cached, true);
    assert.equal(app._fullRefreshInProgress, false);
});

test('an older section response cannot overwrite a newer response for the same section', async () => {
    const inserted = [];
    const section = {
        insertAdjacentHTML(_position, html) { inserted.push(html); },
        remove() {}
    };
    const { app } = loadApp({ elements: { 'section-2': section } });
    const oldResponse = deferred();
    const newResponse = deferred();
    const responses = [oldResponse, newResponse];
    app.request = () => responses.shift().promise;
    const first = app.refreshSection(2);
    const second = app.refreshSection(2);
    newResponse.resolve({ ok: true, text: async () => '<section>new state</section>' });
    await second;
    oldResponse.resolve({ ok: true, text: async () => '<section>old state</section>' });
    await first;
    assert.deepEqual(inserted, ['<section>new state</section>']);
});

test('a section response started before a local tap cannot replace optimistic state', async () => {
    let inserted = false;
    const { app } = loadApp({ elements: { 'section-2': { insertAdjacentHTML() { inserted = true; }, remove() {} } } });
    const response = deferred();
    app.request = () => response.promise;
    const refresh = app.refreshSection(2);
    app.markLocalAction('item_toggled');
    app._pendingActionCount = 1;
    response.resolve({ ok: true, text: async () => '<section>old state</section>' });
    await refresh;
    assert.equal(inserted, false);
    assert.equal(app._needsRefresh, true);
});

test('a section response cannot replace the row being touched before its click arrives', async () => {
    let replacements = 0;
    const { app } = loadApp({
        elements: { 'section-2': { insertAdjacentHTML() { replacements++; }, remove() {} } }
    });
    const response = deferred();
    app.request = () => response.promise;
    const refresh = app.refreshSection(2);
    app._pointerDown = true;
    response.resolve({ ok: true, text: async () => '<section>server state</section>' });
    await refresh;
    assert.equal(replacements, 0);
    assert.equal(app._needsRefresh, true);
});

test('remote events wait while an item is touched instead of removing the future click target', () => {
    const { app } = loadApp();
    let mutations = 0;
    app._pointerDown = true;
    app.toggleRemoteItem = () => { mutations++; };
    app.removeRemoteItem = () => { mutations++; };
    app.refreshStats = () => {};
    for (const type of ['item_toggled', 'item_deleted']) {
        app.handleMessage(JSON.stringify({ type, data: { id: 7, section_id: 2, completed: true } }));
    }
    assert.equal(mutations, 0);
    assert.equal(app._needsRefresh, true);
});

test('a touch starting during section refresh also defers the final list reorder', async () => {
    let reorders = 0;
    const section = { dataset: { sectionId: '2' } };
    const container = {
        querySelectorAll: () => [section],
        appendChild() { reorders++; }
    };
    const { app, context } = loadApp({ elements: { 'sections-list': container, 'section-2': section } });
    const refreshing = deferred();
    const release = deferred();
    app.request = async () => ({ ok: true, json: async () => [{ id: 2 }] });
    app.refreshSection = async () => { refreshing.resolve(); await release.promise; };
    app.updateSectionSelects = () => {};
    context.window.checkEmptyStates = () => {};
    const refresh = app.refreshList();
    await refreshing.promise;
    app._pointerDown = true;
    release.resolve();
    await refresh;
    assert.equal(reorders, 0);
    assert.equal(app._needsRefresh, true);
});

for (const failure of ['network error', 'HTTP 503']) {
    test(`${failure} preserves queued completion and skips refresh that would undo it`, async () => {
        const { app, queued, cleared, timers } = loadApp({ actions: [toggleAction(1, true)] });
        app.offlineStorageReady = true;
        const optimistic = [];
        app._applyOfflineToggle = async (_itemId, _sectionId, completed) => optimistic.push(completed);
        app.request = async () => {
            if (failure === 'network error') throw new TypeError('Connection lost');
            return { ok: false, status: 503 };
        };
        let refreshes = 0;
        app.refreshSectionsSmooth = async () => { refreshes++; };
        app.refreshStats = () => { refreshes++; };
        app.cacheData = async () => { refreshes++; };
        await app.fullRefresh();
        assert.equal(queued.length, 1);
        assert.deepEqual(cleared, []);
        assert.equal(refreshes, 0);
        assert.deepEqual(optimistic, [true]);
        assert.equal(app._pendingCompletions['7'], true);
        assert.equal(app.processingQueue, false);
        assert.ok([...timers.values()].some(timer => timer.delay === 5000), 'a transient failure schedules retry');
    });
}

test('two explicit completion intents replay in FIFO order without timestamp conflict loss', async () => {
    const { app, queued, cleared } = loadApp({ actions: [toggleAction(1, true), toggleAction(2, false)] });
    app.offlineStorageReady = true;
    const sent = [];
    let versionChecks = 0;
    app.getItemVersion = async () => { versionChecks++; return { updated_at: 1900000000 }; };
    app.request = async (_url, options) => { sent.push(options.body); return { ok: true, status: 200 }; };
    await app.processOfflineQueue();
    assert.deepEqual(sent, ['completed=true', 'completed=false']);
    assert.deepEqual(cleared, [1, 2]);
    assert.equal(queued.length, 0);
    assert.equal(versionChecks, 0, 'replaying the first intent must not make the second one look obsolete');
    assert.equal(app.hasPendingChanges(), false);
});

for (const status of ['redirect', 401, 403]) {
    test(`authentication failure ${status} is not acknowledged or retried endlessly`, async () => {
        const { app, queued, cleared, timers } = loadApp({ actions: [toggleAction(1, true)] });
        app.offlineStorageReady = true;
        app.request = async () => ({ ok: status === 'redirect', redirected: status === 'redirect', status: status === 'redirect' ? 200 : status });
        await app.processOfflineQueue();
        assert.equal(queued.length, 1);
        assert.deepEqual(cleared, []);
        assert.equal(app._syncNeedsLogin, true);
        assert.equal(timers.size, 0);
    });
}

const itemOrderCases = require('./item-order-cases.json');
for (const [mode, expected] of Object.entries(itemOrderCases.orders)) {
    test(`completion inserts directly at the saved ${mode} position in either group`, () => {
        const { app } = loadApp();
        const rows = new Map(itemOrderCases.items.map(item => [item.id, {
            dataset: { itemId: String(item.id), sortName: item.name, sortOrder: String(item.sort_order) }
        }]));
        const group = ids => ({
            children: ids.map(id => rows.get(id)),
            insertBefore(item, next) {
                this.children = this.children.filter(row => row !== item);
                const index = next ? this.children.indexOf(next) : this.children.length;
                this.children.splice(index, 0, item);
            }
        });
        // Test both destinations and every insertion position, including ties.
        for (const id of expected) {
            for (const destination of ['active', 'completed']) {
                const container = group(expected.filter(other => other !== id));
                app.insertItemInOrder(container, rows.get(id), mode);
                assert.deepEqual(container.children.map(row => Number(row.dataset.itemId)), expected, `${destination}: item ${id}`);
            }
        }
    });
}
