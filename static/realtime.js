(function (root, factory) {
    const KoffanRealtime = factory();
    if (typeof module === 'object' && module.exports) module.exports = KoffanRealtime;
    if (root) root.KoffanRealtime = KoffanRealtime;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Owns socket lifetime and health checks. The caller owns page lifecycle and data refreshes.
    return class KoffanRealtime {
        constructor(options) {
            this.options = options;
            this.WebSocket = options.WebSocket || globalThis.WebSocket;
            this.setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
            this.clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
            this.connectTimeout = options.connectTimeout ?? 10000;
            this.heartbeatInterval = options.heartbeatInterval ?? 25000;
            this.pongTimeout = options.pongTimeout ?? 10000;
            this.retryMin = options.retryMin ?? 1000;
            this.retryMax = options.retryMax ?? 30000;
            this.socket = null;
            this.connected = false;
            this.enabled = false;
            this.everConnected = false;
            this.retryDelay = this.retryMin;
            this.timers = {};
        }

        start() {
            if (this.enabled) return;
            this.enabled = true;
            this.retryDelay = this.retryMin;
            this.open();
        }

        reconnect() {
            this.enabled = true;
            this.retryDelay = this.retryMin;
            this.disposeSocket();
            this.open();
        }

        pause() {
            this.enabled = false;
            this.disposeSocket();
        }

        stop() {
            this.pause();
        }

        timer(name, callback, delay) {
            this.cancelTimer(name);
            this.timers[name] = this.setTimeout(() => {
                delete this.timers[name];
                callback();
            }, delay);
        }

        cancelTimer(name) {
            if (Object.prototype.hasOwnProperty.call(this.timers, name)) {
                this.clearTimeout(this.timers[name]);
                delete this.timers[name];
            }
        }

        disposeSocket() {
            for (const name of Object.keys(this.timers)) this.cancelTimer(name);
            const socket = this.socket;
            this.socket = null;
            if (socket) {
                socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
                try { socket.close(); } catch (_) {}
            }
            if (this.connected) {
                this.connected = false;
                this.options.onDisconnected?.();
            }
        }

        retry(socket) {
            if (socket !== this.socket || !this.enabled) return;
            this.disposeSocket();
            const delay = this.retryDelay;
            this.retryDelay = Math.min(this.retryMax, this.retryDelay * 2);
            this.timer('retry', () => this.open(), delay);
        }

        open() {
            if (!this.enabled) return;
            let socket;
            try {
                const url = typeof this.options.url === 'function' ? this.options.url() : this.options.url;
                socket = new this.WebSocket(url);
            } catch (_) {
                this.retry(null);
                return;
            }
            this.socket = socket;
            this.timer('connect', () => this.retry(socket), this.connectTimeout);
            socket.onopen = () => {
                if (socket !== this.socket || !this.enabled) return;
                this.cancelTimer('connect');
                this.connected = true;
                this.retryDelay = this.retryMin;
                const reconnected = this.everConnected;
                this.everConnected = true;
                this.scheduleHeartbeat(socket);
                this.options.onConnected?.({ reconnected });
            };
            socket.onclose = socket.onerror = () => this.retry(socket);
            socket.onmessage = (event) => {
                if (socket !== this.socket || !this.enabled) return;
                let isPong = false;
                try { isPong = JSON.parse(event.data).type === 'pong'; } catch (_) {}
                if (isPong) {
                    this.cancelTimer('pong');
                    return;
                }
                this.options.onMessage?.(event.data);
            };
        }

        scheduleHeartbeat(socket) {
            this.timer('heartbeat', () => {
                if (socket !== this.socket || !this.connected) return;
                try {
                    // Install the deadline first so an immediate pong can cancel it too.
                    this.timer('pong', () => this.retry(socket), this.pongTimeout);
                    socket.send(JSON.stringify({ type: 'ping' }));
                } catch (_) {
                    this.retry(socket);
                    return;
                }
                this.scheduleHeartbeat(socket);
            }, this.heartbeatInterval);
        }
    };
});
