const test = require('node:test');
const assert = require('node:assert/strict');
const KoffanRealtime = require('../static/realtime.js');

function harness(overrides = {}) {
    let now = 0;
    let nextTimer = 0;
    const timers = new Map();
    const sockets = [];
    const messages = [];
    const connections = [];
    let disconnections = 0;
    class FakeSocket {
        constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
        close() { this.closed = true; this.onclose?.(); }
        send(data) { this.sent.push(data); }
        open() { this.onopen?.(); }
        message(data) { this.onmessage?.({ data }); }
        fail() { this.onerror?.(); }
    }
    const client = new KoffanRealtime({
        url: () => 'ws://localhost/ws', WebSocket: FakeSocket,
        setTimeout: (callback, delay) => {
            const id = ++nextTimer;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        onConnected: state => connections.push(state),
        onDisconnected: () => disconnections++,
        onMessage: data => messages.push(data),
        ...overrides
    });
    function tick(duration) {
        const end = now + duration;
        while (true) {
            const entry = [...timers.entries()].filter(([, timer]) => timer.due <= end)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!entry) break;
            timers.delete(entry[0]);
            now = entry[1].due;
            entry[1].callback();
        }
        now = end;
    }
    return { client, sockets, timers, tick, messages, connections, get disconnections() { return disconnections; } };
}

test('start is idempotent and forwards messages while consuming pong', () => {
    const h = harness();
    h.client.start(); h.client.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, 'ws://localhost/ws');
    h.sockets[0].open();
    h.sockets[0].message('{"type":"item_toggled"}');
    h.sockets[0].message('{"type":"pong"}');
    assert.deepEqual(h.messages, ['{"type":"item_toggled"}']);
    assert.deepEqual(h.connections, [{ reconnected: false }]);
});

test('socket failures retry indefinitely with capped exponential backoff', () => {
    const h = harness();
    h.client.start();
    for (let attempt = 0; attempt < 12; attempt++) {
        h.sockets.at(-1).fail();
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        h.tick(delay - 1);
        assert.equal(h.sockets.length, attempt + 1);
        h.tick(1);
        assert.equal(h.sockets.length, attempt + 2);
    }
    h.client.stop();
    assert.equal(h.timers.size, 0);
});

test('connection attempts time out and retry even when no close event arrives', () => {
    const h = harness(); h.client.start();
    h.tick(10000);
    assert.equal(h.sockets[0].closed, true);
    h.tick(1000);
    assert.equal(h.sockets.length, 2);
});

test('missing pong retires an apparently open zombie socket', () => {
    const h = harness(); h.client.start(); h.sockets[0].open();
    h.tick(25000);
    assert.deepEqual(h.sockets[0].sent, ['{"type":"ping"}']);
    h.tick(10000);
    assert.equal(h.sockets[0].closed, true);
    assert.equal(h.client.connected, false);
    assert.equal(h.disconnections, 1);
    h.tick(1000); h.sockets[1].open();
    assert.deepEqual(h.connections, [{ reconnected: false }, { reconnected: true }]);
});

test('pong keeps the connection healthy across repeated heartbeat intervals', () => {
    const h = harness(); h.client.start(); h.sockets[0].open();
    for (let i = 0; i < 10; i++) {
        h.tick(25000);
        h.sockets[0].message('{"type":"pong"}');
    }
    assert.equal(h.sockets.length, 1);
    assert.equal(h.client.connected, true);
    assert.equal(h.sockets[0].sent.length, 10);
});

test('reconnect replaces OPEN sockets and ignores callbacks from superseded sockets', () => {
    const h = harness(); h.client.start(); h.sockets[0].open();
    const old = h.sockets[0];
    const stale = { open: old.onopen, close: old.onclose, message: old.onmessage };
    h.client.reconnect();
    assert.equal(old.closed, true);
    assert.equal(h.sockets.length, 2);
    stale.open(); stale.close(); stale.message({ data: 'stale' });
    assert.equal(h.client.socket, h.sockets[1]);
    assert.equal(h.client.connected, false);
    assert.deepEqual(h.messages, []);
    h.sockets[1].open();
    assert.deepEqual(h.connections, [{ reconnected: false }, { reconnected: true }]);
    h.tick(1000);
    assert.equal(h.sockets.length, 2);
});

test('pause cancels retry and heartbeat timers; start resumes cleanly', () => {
    const h = harness(); h.client.start(); h.sockets[0].open();
    h.client.pause(); h.tick(100000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.client.socket, null);
    h.client.start(); h.sockets[1].fail(); h.client.pause(); h.tick(100000);
    assert.equal(h.sockets.length, 2);
    h.client.start();
    assert.equal(h.sockets.length, 3);
});

test('constructor and send failures recover without leaking timers', () => {
    let attempts = 0;
    const h = harness({ WebSocket: class { constructor() { attempts++; throw Error('Unavailable'); } } });
    h.client.start(); h.tick(7000);
    assert.equal(attempts, 4);
    h.client.stop(); assert.equal(h.timers.size, 0);
    const sending = harness(); sending.client.start(); sending.sockets[0].open();
    sending.sockets[0].send = () => { throw Error('Closed'); };
    sending.tick(26000);
    assert.equal(sending.sockets.length, 2);
});
