// Durable offline list, section and item mutations shared by all open tabs.
(function(root) {
    'use strict';

    const KEY = 'offline_crud';
    const COLLECTION = { list: 'lists', section: 'sections', item: 'items' };
    const FIELDS = {
        list: ['name', 'icon', 'sort_order', 'is_active', 'show_completed'],
        section: ['name', 'list_id', 'sort_order', 'sort_mode'],
        item: ['name', 'description', 'section_id', 'quantity', 'completed', 'uncertain', 'sort_order']
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const emptyState = () => ({ lists: [], sections: [], items: [] });
    const validID = id => Number.isSafeInteger(id) && id !== 0;

    function uuid() {
        const crypto = root.crypto || globalThis.crypto;
        if (crypto?.randomUUID) return crypto.randomUUID();
        if (!crypto?.getRandomValues) throw new Error('Secure random identifiers are unavailable');
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    function error(message, code = 'validation', status) {
        return Object.assign(new Error(message), { code, status });
    }

    function normalizeSnapshot(snapshot) {
        if (!snapshot || !Object.values(COLLECTION).every(key => Array.isArray(snapshot[key]))) {
            throw error('Invalid offline snapshot', 'protocol');
        }
        const result = emptyState();
        for (const key of Object.values(COLLECTION)) {
            const ids = new Set();
            result[key] = snapshot[key].map(value => {
                if (!value || !validID(value.id) || ids.has(value.id)) throw error('Invalid snapshot entity', 'protocol');
                ids.add(value.id);
                const record = clone(value);
                // Sections in the normalized model never contain a second item copy.
                if (key === 'sections') delete record.items;
                return record;
            });
        }
        return result;
    }

    function resolveID(aliases, entity, id) {
        const seen = new Set();
        while (aliases[entity]?.[id] !== undefined && !seen.has(id)) {
            seen.add(id);
            id = aliases[entity][id];
        }
        return id;
    }

    function remapOperation(operation, aliases) {
        const result = clone(operation);
        result.entity_id = resolveID(aliases, result.entity, result.entity_id);
        if (result.values.list_id !== undefined) result.values.list_id = resolveID(aliases, 'list', result.values.list_id);
        if (result.values.section_id !== undefined) result.values.section_id = resolveID(aliases, 'section', result.values.section_id);
        return result;
    }

    function find(state, entity, id) {
        return state[COLLECTION[entity]].find(value => value.id === id);
    }

    function validateValues(entity, action, values) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw error('Operation values must be an object');
        const result = clone(values);
        for (const [field, value] of Object.entries(result)) {
            if (!FIELDS[entity].includes(field)) throw error(`Unsupported ${entity} field: ${field}`);
            if (['name', 'description', 'icon'].includes(field) && typeof value !== 'string') throw error(`${field} must be text`);
            if (field === 'name') {
                result.name = value.trim();
                if (!result.name) throw error('Name is required');
            }
            if (['list_id', 'section_id'].includes(field) && !validID(value)) throw error(`${field} must be a nonzero integer`);
            if (['sort_order', 'quantity'].includes(field) && (!Number.isSafeInteger(value) || value < 0)) throw error(`${field} must be a nonnegative integer`);
            if (['is_active', 'show_completed', 'completed', 'uncertain'].includes(field) && typeof value !== 'boolean') throw error(`${field} must be boolean`);
            if (field === 'sort_mode' && !['manual', 'alphabetical', 'alphabetical_desc'].includes(value)) throw error('Invalid section sort mode');
        }
        if (action === 'create' && !result.name) throw error('Name is required');
        if (action === 'delete' && Object.keys(result).length) throw error('Delete operations cannot update fields');
        return result;
    }

    function defaults(state, entity, values) {
        const siblings = state[COLLECTION[entity]].filter(value => entity === 'list' ||
            (entity === 'section' ? value.list_id === values.list_id : value.section_id === values.section_id));
        const sort_order = Math.max(-1, ...siblings.map(value => value.sort_order || 0)) + 1;
        const common = { sort_order };
        if (entity === 'list') return { ...common, icon: '🛒', is_active: state.lists.length === 0, show_completed: true, ...values };
        if (entity === 'section') return { ...common, sort_mode: 'manual', ...values };
        return { ...common, description: '', quantity: 0, completed: false, uncertain: false, ...values };
    }

    function apply(state, operation, strict = true) {
        const { entity, action, entity_id: id, values } = operation;
        const collection = COLLECTION[entity];
        const existing = find(state, entity, id);
        if (action === 'delete') {
            if (entity === 'list') {
                const sectionIDs = new Set(state.sections.filter(section => section.list_id === id).map(section => section.id));
                state.sections = state.sections.filter(section => section.list_id !== id);
                state.items = state.items.filter(item => !sectionIDs.has(item.section_id));
            } else if (entity === 'section') {
                state.items = state.items.filter(item => item.section_id !== id);
            }
            state[collection] = state[collection].filter(value => value.id !== id);
            return;
        }
        if (action === 'update' && !existing) {
            if (strict) throw error('The edited entity no longer exists', 'conflict', 409);
            return;
        }
        const next = { ...(existing || defaults(state, entity, values)), ...values, id };
        if (entity === 'section' && !find(state, 'list', next.list_id)) {
            if (strict) throw error('The destination list no longer exists', 'conflict', 409);
            return;
        }
        if (entity === 'item' && !find(state, 'section', next.section_id)) {
            if (strict) throw error('The destination section no longer exists', 'conflict', 409);
            return;
        }
        if (entity === 'list' && next.is_active) state.lists.forEach(list => { list.is_active = false; });
        if (existing) Object.assign(existing, next);
        else state[collection].push(next);
    }

    function rebase(record, snapshot = record.snapshot) {
        const previous = record.state;
        const state = normalizeSnapshot(snapshot);
        // Keep a pending edit visible when a remote deletion creates a conflict.
        // The server will reject it with 409; the durable operation remains intact.
        function restore(entity, id) {
            if (find(state, entity, id)) return;
            const old = previous[COLLECTION[entity]].find(value => resolveID(record.aliases, entity, value.id) === id);
            if (!old) return;
            const copy = clone(old);
            copy.id = id;
            if (entity === 'section') {
                copy.list_id = resolveID(record.aliases, 'list', copy.list_id);
                restore('list', copy.list_id);
            } else if (entity === 'item') {
                copy.section_id = resolveID(record.aliases, 'section', copy.section_id);
                restore('section', copy.section_id);
            }
            state[COLLECTION[entity]].push(copy);
        }
        for (const pending of record.operations) {
            const operation = remapOperation(pending, record.aliases);
            if (operation.action === 'update') restore(operation.entity, operation.entity_id);
            if (operation.action !== 'delete') {
                if (operation.entity === 'section' && operation.values.list_id !== undefined) restore('list', operation.values.list_id);
                if (operation.entity === 'item' && operation.values.section_id !== undefined) restore('section', operation.values.section_id);
            }
            apply(state, operation, false);
        }
        record.snapshot = normalizeSnapshot(snapshot);
        record.state = state;
    }

    class OfflineCRUD {
        constructor({ storage, request, onChange, onError }) {
            if (!storage?.getMetadata || !storage?.setMetadata || typeof request !== 'function') throw error('Offline storage and a request function are required');
            this.storage = storage;
            this.request = request;
            this.onChange = onChange;
            this.onError = onError;
            this._record = null;
            this._writes = Promise.resolve();
            this._network = Promise.resolve();
            this._syncPromise = null;
            this._refreshPromise = null;
            this._initPromise = null;
            this._closed = false;
            // Node tests and non-browser consumers do not need a live channel.
            if (typeof window !== 'undefined' && root.BroadcastChannel) {
                this._channel = new root.BroadcastChannel('koffan-offline-crud');
                this._channel.onmessage = () => {
                    this._transact(() => ({ save: false })).catch(cause => this._report(cause));
                };
            }
        }

        get pendingCount() { return this._record?.operations.length || 0; }
        get clientId() { return this._record?.client_id || null; }
        getState() { return clone(this._record?.state || emptyState()); }
        getPendingOperations() { return clone(this._record?.operations || []); }
        resolveID(entity, id) {
            return resolveID(this._record?.aliases || {}, entity, Number(id));
        }

        _report(cause) {
            try { this.onError?.(cause); } catch (_) { /* Observer failures cannot discard durable work. */ }
        }

        _emit() {
            try {
                const returned = this.onChange?.(this.getState(), { pendingCount: this.pendingCount, clientId: this.clientId });
                if (returned?.catch) returned.catch(cause => this._report(cause));
            } catch (cause) { this._report(cause); }
        }

        _lock(name, callback) {
            const locks = root.navigator?.locks || globalThis.navigator?.locks;
            return locks ? locks.request(name, callback) : callback();
        }

        _newRecord() {
            return {
                version: 1, revision: 0, client_id: uuid(), next_temp_id: -1,
                snapshot: emptyState(), state: emptyState(), initialized: false,
                operations: [], sent_ids: [], importedLegacyIds: {}, aliases: { list: {}, section: {}, item: {} }
            };
        }

        _transact(change) {
            const work = this._writes.then(() => this._lock('koffan-offline-crud-store', async () => {
                const stored = await this.storage.getMetadata(KEY);
                const record = stored ? clone(stored) : this._newRecord();
                if (record.version !== 1) throw error('Unsupported offline database version', 'storage');
                const result = await change(record) || {};
                const changed = !stored || result.save !== false;
                if (changed) {
                    record.revision++;
                    await this.storage.setMetadata(KEY, record);
                }
                const notify = !this._record || this._record.revision !== record.revision;
                this._record = clone(record);
                if (notify) this._emit();
                if (changed) this._channel?.postMessage({ revision: record.revision });
                return result.value;
            }));
            this._writes = work.catch(() => {});
            return work;
        }

        async init() {
            if (!this._initPromise) {
                this._initPromise = this._transact(() => ({ save: false })).catch(cause => {
                    this._initPromise = null;
                    this._report(cause);
                    throw cause;
                });
            }
            await this._initPromise;
            return this;
        }

        async seed(snapshot) {
            await this.init();
            try {
                const normalized = normalizeSnapshot(snapshot);
                return await this._transact(record => {
                    if (record.initialized || record.operations.length) return { save: false, value: false };
                    rebase(record, normalized);
                    record.initialized = true;
                    return { value: true };
                });
            } catch (cause) { this._report(cause); throw cause; }
        }

        async mutate(input) {
            const operations = await this.mutateMany([input]);
            return operations[0];
        }

        async mutateMany(inputs) {
            await this.init();
            try {
                if (!Array.isArray(inputs)) throw error('Offline mutation batch must be an array');
                return await this._transact(record => {
                    record.importedLegacyIds ||= {};
                    let changed = false;
                    const operations = inputs.map(input => {
                        const legacyID = input?.legacy_id === undefined ? null : String(input.legacy_id);
                        if (legacyID !== null && Object.prototype.hasOwnProperty.call(record.importedLegacyIds, legacyID)) {
                            return clone(record.importedLegacyIds[legacyID]);
                        }
                        const { entity, action } = input || {};
                        if (!COLLECTION[entity] || !['create', 'update', 'delete'].includes(action)) throw error('Invalid offline operation');
                        const values = validateValues(entity, action, input.values || {});
                        const id = action === 'create' ? record.next_temp_id-- : input.entity_id;
                        if (!validID(id)) throw error('Entity ID must be a nonzero integer');
                        const operation = remapOperation({ id: uuid(), entity, action, entity_id: id, values }, record.aliases);
                        if (action === 'create') operation.values = defaults(record.state, entity, operation.values);
                        apply(record.state, operation);
                        record.operations.push(operation);
                        if (legacyID !== null) record.importedLegacyIds[legacyID] = clone(operation);
                        changed = true;
                        return clone(operation);
                    });
                    return { save: changed, value: operations };
                });
            } catch (cause) { this._report(cause); throw cause; }
        }

        async discardOperation(id) {
            await this.init();
            try {
                return await this._transact(record => {
                    const discarded = new Set([id]);
                    const removedEntities = { list: new Set(), section: new Set(), item: new Set() };
                    // Discarding a new parent also discards operations that require
                    // that parent. Independent edits and existing entities remain.
                    for (const operation of record.operations) {
                        const effective = remapOperation(operation, record.aliases);
                        if (removedEntities[effective.entity].has(effective.entity_id) ||
                            removedEntities.list.has(effective.values.list_id) ||
                            removedEntities.section.has(effective.values.section_id)) discarded.add(operation.id);
                        if (discarded.has(operation.id) && operation.action === 'create') removedEntities[effective.entity].add(effective.entity_id);
                    }
                    const removed = record.operations.filter(operation => discarded.has(operation.id)).map(operation => operation.id);
                    if (!removed.length) return { save: false, value: [] };
                    record.operations = record.operations.filter(operation => !discarded.has(operation.id));
                    record.sent_ids = record.sent_ids.filter(operationID => !discarded.has(operationID));
                    rebase(record);
                    return { value: removed };
                });
            } catch (cause) { this._report(cause); throw cause; }
        }

        _networkWork(callback) {
            const work = this._network.then(() => this._lock('koffan-offline-crud-sync', callback));
            this._network = work.catch(() => {});
            return work;
        }

        async _json(url, options) {
            const response = await this.request(url, options);
            if (response.redirected || !response.ok) {
                let details;
                try { details = await response.json(); } catch (_) {}
                const status = response.redirected ? 401 : response.status;
                const cause = error(details?.error || 'Offline synchronization failed', status === 409 ? 'conflict' : (status === 401 || status === 403 ? 'authentication' : 'http'), status);
                cause.operationId = details?.operation_id;
                throw cause;
            }
            return response.json();
        }

        async _refresh() {
            const snapshot = normalizeSnapshot(await this._json('/api/offline/snapshot', { method: 'GET', cache: 'no-store' }));
            await this._transact(record => {
                rebase(record, snapshot);
                record.initialized = true;
            });
            return this.getState();
        }

        async refresh() {
            await this.init();
            if (!this._refreshPromise) {
                // Serialize snapshot requests with synchronization, but not mutations.
                this._refreshPromise = this._networkWork(() => this._refresh())
                    .catch(cause => { this._report(cause); throw cause; })
                    .finally(() => { this._refreshPromise = null; });
            }
            return this._refreshPromise;
        }

        async sync() {
            await this.init();
            if (!this._syncPromise) {
                this._syncPromise = this._networkWork(async () => {
                    let synced = false;
                    while (!this._closed) {
                        const batch = await this._transact(record => {
                            const operations = record.operations.slice(0, 100);
                            if (!operations.length) return { save: false, value: null };
                            const sent = new Set(record.sent_ids);
                            operations.forEach(operation => sent.add(operation.id));
                            record.sent_ids = [...sent];
                            return { value: { client_id: record.client_id, operations: clone(operations) } };
                        });
                        if (!batch) {
                            if (!synced) await this._refresh();
                            break;
                        }
                        const reply = await this._json('/api/offline/sync', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch)
                        });
                        const snapshot = normalizeSnapshot(reply.snapshot);
                        if (!Array.isArray(reply.results) || !reply.results.length) throw error('Synchronization did not acknowledge any operations', 'protocol');
                        const sent = new Map(batch.operations.map(operation => [operation.id, operation]));
                        const acknowledgements = new Set();
                        for (const result of reply.results) {
                            const operation = sent.get(result.id);
                            if (!operation || acknowledgements.has(result.id) || operation.entity !== result.entity || operation.entity_id !== result.entity_id || !Number.isSafeInteger(result.server_id) || result.server_id <= 0) {
                                throw error('Invalid synchronization acknowledgement', 'protocol');
                            }
                            acknowledgements.add(result.id);
                        }
                        await this._transact(record => {
                            for (const result of reply.results) {
                                if (result.entity_id < 0) record.aliases[result.entity][result.entity_id] = result.server_id;
                            }
                            record.operations = record.operations.filter(operation => !acknowledgements.has(operation.id));
                            record.sent_ids = record.sent_ids.filter(id => !acknowledgements.has(id));
                            const previouslySent = new Set(record.sent_ids);
                            // A request whose acknowledgement was lost must retain its exact
                            // payload and operation ID for the server's idempotency check.
                            record.operations = record.operations.map(operation => previouslySent.has(operation.id) ? operation : remapOperation(operation, record.aliases));
                            rebase(record, snapshot);
                            record.initialized = true;
                        });
                        synced = true;
                    }
                    return this.getState();
                }).catch(cause => { this._report(cause); throw cause; })
                    .finally(() => { this._syncPromise = null; });
            }
            return this._syncPromise;
        }

        close() {
            this._closed = true;
            this._channel?.close();
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = OfflineCRUD;
    root.OfflineCRUD = OfflineCRUD;
})(typeof window !== 'undefined' ? window : globalThis);
