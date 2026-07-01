/**
 * TextAdventureEngine — a synthetic, Archipelago-naive text adventure
 * renderer + command parser. Designed to be drivable both standalone
 * (loads bundled sample worlds, auto-mutates state) and from a wrapper
 * (managed mode: emits events, wrapper drives state).
 *
 * The wrapper-side integration is documented in the consuming repo at
 * docs/json/developer/procgen/text-adventure.md.
 */

const DEFAULT_OPTIONS = Object.freeze({
    managed: false,
    discoveryMode: 'full',     // 'full' | 'discovered'
    messageHistoryLimit: 10,
    dataPath: './data',         // relative path to manifest.json + world files
    autoFocusCommandInput: true, // refocus the input after every action
});

export class TextAdventureEngine {
    constructor(container, options = {}) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('TextAdventureEngine: container must be an HTMLElement');
        }
        this.container = container;
        this.options = { ...DEFAULT_OPTIONS, ...options };

        this.world = null;
        this.state = {
            currentRoomId: null,
            rooms: {},      // {[roomId]: {discovered: bool}}
            items: {},      // {[roomId]: {[itemId]: {discovered, collected, accessible}}}
            exits: {},      // {[roomId]: {[exitId]: {accessible}}}
            inventory: {},  // {[invItemId]: {count, label}}
        };
        this.messages = [];
        this.listeners = {};
        this._batchDepth = 0;
        this._renderQueued = false;

        this._manifest = null;
        this._buildDOM();
        this._wireInput();
        this._showInitialView();
    }

    // ─── public: world loading ─────────────────────────────────────

    loadWorld(world) {
        if (!world || typeof world !== 'object' || !world.rooms || !world.startRoomId) {
            throw new Error('TextAdventureEngine.loadWorld: world must have rooms and startRoomId');
        }
        this.world = world;
        this.state = {
            currentRoomId: null,
            rooms: {},
            items: {},
            exits: {},
            inventory: {},
        };
        for (const roomId of Object.keys(world.rooms)) {
            this.state.rooms[roomId] = { discovered: false };
            this.state.items[roomId] = {};
            this.state.exits[roomId] = {};
            const room = world.rooms[roomId];
            for (const item of (room.items || [])) {
                this.state.items[roomId][item.id] = { discovered: false, collected: false, accessible: true };
            }
            for (const exit of (room.exits || [])) {
                this.state.exits[roomId][exit.id] = { accessible: true, discovered: false };
            }
        }
        this.messages = [];
        this._hidePicker();
        this.setCurrentRoom(world.startRoomId);
    }

    async loadDefaultWorld(name) {
        await this._ensureManifest();
        if (!this._manifest || !this._manifest.worlds || this._manifest.worlds.length === 0) {
            throw new Error('TextAdventureEngine: no worlds found in manifest');
        }
        const entry = name
            ? this._manifest.worlds.find(w => w.name === name)
            : this._manifest.worlds[0];
        if (!entry) {
            throw new Error(`TextAdventureEngine: no world named '${name}' in manifest`);
        }
        const resp = await fetch(`${this.options.dataPath}/${entry.file}`);
        if (!resp.ok) {
            throw new Error(`TextAdventureEngine: failed to load ${entry.file}: ${resp.status}`);
        }
        this.loadWorld(await resp.json());
    }

    async getAvailableDefaultWorlds() {
        await this._ensureManifest();
        return this._manifest?.worlds ?? [];
    }

    async _ensureManifest() {
        if (this._manifest) return;
        try {
            const resp = await fetch(`${this.options.dataPath}/manifest.json`);
            if (resp.ok) {
                this._manifest = await resp.json();
            } else {
                this._manifest = { worlds: [] };
            }
        } catch {
            this._manifest = { worlds: [] };
        }
    }

    // ─── public: state mutation ────────────────────────────────────

    setCurrentRoom(roomId) {
        if (!this.world?.rooms[roomId]) {
            this._queueMessage(`Cannot move to unknown room '${roomId}'.`, 'error');
            this._queueRender();
            return;
        }
        const isNewRoom = this.state.currentRoomId !== roomId;
        this.state.currentRoomId = roomId;
        this.state.rooms[roomId].discovered = true;
        this._queueRender();
        // Refocus the command input on each new-room entry so the
        // player can immediately type a command without clicking. Gated
        // by autoFocusCommandInput so hosts that own focus elsewhere
        // (e.g. a tab system that activates a different panel) can
        // disable it.
        if (isNewRoom) this._maybeFocus();
    }

    setRoomDiscovered(roomId, value) {
        if (this.state.rooms[roomId]) {
            this.state.rooms[roomId].discovered = !!value;
            this._queueRender();
        }
    }

    setItemDiscovered(roomId, itemId, value) {
        const slot = this.state.items[roomId]?.[itemId];
        if (slot) { slot.discovered = !!value; this._queueRender(); }
    }

    setItemCollected(roomId, itemId, value) {
        const slot = this.state.items[roomId]?.[itemId];
        if (!slot) return;
        const wasCollected = !!slot.collected;
        const nextCollected = !!value;
        slot.collected = nextCollected;
        // First-time collection is the "discovery" moment in AP terms.
        // Emit a styled message highlighting the item's name so newly-
        // found items visually pop in the scrollback. Skipped in
        // managed mode — the wrapper owns message display there and
        // may push a templated check message that includes {item}
        // highlighted inline; a separate discovery line would duplicate.
        if (!wasCollected && nextCollected && !this.options.managed) {
            const item = this.world?.rooms[roomId]?.items.find(i => i.id === itemId);
            if (item) {
                this._queueMessage(
                    `You discover: <span class="tae-item-name">${escapeHtml(item.label)}</span>`,
                    'discovery',
                    { html: true },
                );
            }
        }
        this._queueRender();
    }

    setItemAccessible(roomId, itemId, value) {
        const slot = this.state.items[roomId]?.[itemId];
        if (slot) { slot.accessible = !!value; this._queueRender(); }
    }

    setExitAccessible(roomId, exitId, value) {
        const slot = this.state.exits[roomId]?.[exitId];
        if (slot) { slot.accessible = !!value; this._queueRender(); }
    }

    setExitDiscovered(roomId, exitId, value) {
        const slot = this.state.exits[roomId]?.[exitId];
        if (slot) { slot.discovered = !!value; this._queueRender(); }
    }

    /**
     * Display arbitrary host-supplied status info in the engine's
     * header bar. The engine is Archipelago-naive — it doesn't know
     * what "mana" means; it just renders whatever HTML-safe text the
     * host gives it. Pass null or an empty object to hide the bar.
     *
     * Recognised fields (all optional):
     *   text  — plain-text status line (left side of the bar)
     *   html  — pre-escaped HTML status line (replaces text if both)
     */
    setHeaderInfo(info) {
        this._headerInfo = info && (info.text || info.html) ? info : null;
        this._queueRender();
    }

    setInventory(items) {
        this.state.inventory = {};
        for (const [id, entry] of Object.entries(items || {})) {
            this.state.inventory[id] = { count: entry.count ?? 1, label: entry.label ?? id };
        }
        this._queueRender();
    }

    addInventoryItem(itemId, label, count = 1) {
        const existing = this.state.inventory[itemId];
        if (existing) {
            existing.count += count;
        } else {
            this.state.inventory[itemId] = { count, label: label ?? itemId };
        }
        this._queueRender();
    }

    removeInventoryItem(itemId, count = 1) {
        const existing = this.state.inventory[itemId];
        if (!existing) return;
        existing.count -= count;
        if (existing.count <= 0) delete this.state.inventory[itemId];
        this._queueRender();
    }

    displayMessage(text, kind = 'normal', opts = {}) {
        // opts.html = true marks `text` as pre-escaped raw HTML so
        // styled spans (e.g. wrapper-side templated discoveries with
        // <span class="tae-item-name">…</span> inline) survive the
        // render pass intact. Without it the text is HTML-escaped.
        this._queueMessage(text, kind, opts);
        this._queueRender();
    }

    setDiscoveryMode(mode) {
        if (mode !== 'full' && mode !== 'discovered') {
            throw new Error(`setDiscoveryMode: mode must be 'full' or 'discovered', got '${mode}'`);
        }
        if (this.options.discoveryMode === mode) return;
        this.options.discoveryMode = mode;
        this._queueRender();
    }

    /**
     * Update one of the engine's runtime options. Used by wrappers
     * pushing host settings across an iframe boundary. Unknown keys
     * are silently ignored so older engine versions don't break newer
     * wrappers. Re-renders only when the change actually affects what's
     * shown.
     */
    setOption(key, value) {
        if (!(key in this.options)) return;
        if (this.options[key] === value) return;
        this.options[key] = value;
        if (key === 'messageHistoryLimit') {
            if (Number.isFinite(value) && value > 0 && this.messages.length > value) {
                this.messages = this.messages.slice(-value);
                this._queueRender();
            }
        }
    }

    batchUpdate(fn) {
        this._batchDepth++;
        try {
            fn();
        } finally {
            this._batchDepth--;
            if (this._batchDepth === 0 && this._renderQueued) {
                this._renderQueued = false;
                this._render();
            }
        }
    }

    // ─── public: programmatic triggers ─────────────────────────────

    triggerExit(roomId, exitId, opts = {}) {
        const exit = this.world?.rooms[roomId]?.exits.find(e => e.id === exitId);
        if (!exit) {
            this.displayMessage(`No exit '${exitId}' in room '${roomId}'.`, 'error');
            return;
        }
        const accessible = this.state.exits[roomId]?.[exitId]?.accessible ?? true;
        if (!accessible && !opts.ignoreAccessibility) {
            this._emit('command:moveBlocked', { fromRoomId: roomId, exitId, targetRoomId: exit.targetRoomId, reason: 'inaccessible' });
            if (!this.options.managed) {
                this.displayMessage(`You can't go that way: ${exit.label}.`, 'error');
            }
            return;
        }
        this._emit('command:move', { fromRoomId: roomId, exitId, targetRoomId: exit.targetRoomId });
        if (!this.options.managed) {
            this.setCurrentRoom(exit.targetRoomId);
        }
    }

    /**
     * Trigger an explore action for the given room. Emits
     * `command:explore`. In standalone mode, picks one undiscovered
     * exit or item from the room and marks it discovered (mirrors
     * the host's discovery module behavior for out-of-loop explore).
     * In managed mode, the wrapper takes care of the discovery
     * delta — engine just emits the event.
     */
    triggerExplore(roomId, _opts = {}) {
        const room = this.world?.rooms[roomId];
        if (!room) {
            this.displayMessage(`No room '${roomId}'.`, 'error');
            return;
        }
        this._emit('command:explore', { roomId });
        if (this.options.managed) return;

        // Standalone: pick one undiscovered candidate.
        const candidates = [];
        for (const exit of room.exits) {
            const targetRoomDiscovered = this.state.rooms[exit.targetRoomId]?.discovered;
            if (exit.targetRoomId && !targetRoomDiscovered) {
                candidates.push({ kind: 'exit', exit });
            }
        }
        for (const item of room.items) {
            const slot = this.state.items[roomId]?.[item.id];
            if (slot && !slot.discovered) {
                candidates.push({ kind: 'item', item });
            }
        }
        if (candidates.length === 0) {
            this.displayMessage('Nothing left to discover here.', 'system');
            return;
        }
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        if (pick.kind === 'exit') {
            this.setRoomDiscovered(pick.exit.targetRoomId, true);
            this.displayMessage(`You discover a passage: ${pick.exit.label}.`, 'success');
        } else {
            this.setItemDiscovered(roomId, pick.item.id, true);
            this.displayMessage(`You discover: ${pick.item.label}.`, 'success');
        }
    }

    triggerExamineItem(roomId, itemId, opts = {}) {
        const item = this.world?.rooms[roomId]?.items.find(i => i.id === itemId);
        if (!item) {
            this.displayMessage(`No item '${itemId}' in room '${roomId}'.`, 'error');
            return;
        }
        const slot = this.state.items[roomId]?.[itemId];
        const accessible = slot?.accessible ?? true;
        if (!accessible && !opts.ignoreAccessibility) {
            // Managed wrappers can format their own templated
            // inaccessible message; the engine only displays the
            // generic one in standalone mode.
            this._emit('command:examineBlocked', { roomId, itemId, reason: 'inaccessible' });
            if (!this.options.managed) {
                this.displayMessage(`You can't interact with that: ${item.label}.`, 'error');
            }
            return;
        }
        if (slot?.collected) {
            this._emit('command:examineBlocked', { roomId, itemId, reason: 'collected' });
            if (!this.options.managed) {
                this.displayMessage(`${item.label}: already examined.`, 'system');
            }
            return;
        }
        this._emit('command:examine', { roomId, itemId });
        this.batchUpdate(() => {
            // Managed mode: wrapper pushes the (possibly templated)
            // examination message itself via displayMessage. Standalone
            // mode: engine shows the item's bundled description and
            // mutates state directly.
            if (!this.options.managed) {
                this.displayMessage(item.description || item.label, 'normal');
                this.setItemDiscovered(roomId, itemId, true);
                this.setItemCollected(roomId, itemId, true);
            }
        });
    }

    simulateCommand(rawText, opts = {}) {
        this._handleCommand(rawText, opts);
    }

    // ─── public: lifecycle ─────────────────────────────────────────

    focus() {
        this._input?.focus();
    }

    /**
     * Focus the command input only when autoFocusCommandInput is on.
     * Used by hosts that want to refocus on panel activation /
     * region change but should respect the user's setting (which
     * may disable auto-focus to keep focus on another panel).
     */
    maybeFocus() {
        this._maybeFocus();
    }

    destroy() {
        this.container.innerHTML = '';
        this.listeners = {};
        this.world = null;
    }

    // ─── public: events ────────────────────────────────────────────

    on(event, callback) {
        (this.listeners[event] = this.listeners[event] || []).push(callback);
        return () => this.off(event, callback);
    }

    off(event, callback) {
        const arr = this.listeners[event];
        if (!arr) return;
        const i = arr.indexOf(callback);
        if (i >= 0) arr.splice(i, 1);
    }

    _emit(event, payload) {
        for (const cb of (this.listeners[event] || [])) {
            try { cb(payload); } catch (e) { console.error(`[engine] listener for ${event} threw:`, e); }
        }
    }

    // ─── command parsing ───────────────────────────────────────────

    _handleCommand(rawText, opts = {}) {
        const text = (rawText || '').trim();
        if (!text) return;

        const room = this.world?.rooms[this.state.currentRoomId];
        if (!room) {
            this._emit('command:custom', { rawCommand: text });
            return;
        }

        const cmd = this._parseCommand(text, room);
        switch (cmd.type) {
            case 'help':
                this.displayMessage(this._helpText(), 'system');
                return;
            case 'inventory': {
                const ids = Object.keys(this.state.inventory);
                if (ids.length === 0) {
                    this.displayMessage('Your inventory is empty.', 'system');
                } else {
                    const lines = ids.map(id => {
                        const { count, label } = this.state.inventory[id];
                        return count > 1 ? `  ${label} ×${count}` : `  ${label}`;
                    });
                    this.displayMessage('Inventory:\n' + lines.join('\n'), 'system');
                }
                return;
            }
            case 'look':
                this._describeRoom(room, { force: true });
                return;
            case 'explore':
                this.triggerExplore(room.id, opts);
                return;
            case 'move':
                this.triggerExit(room.id, cmd.exit.id, opts);
                return;
            case 'examine':
                this.triggerExamineItem(room.id, cmd.item.id, opts);
                return;
            case 'error':
                this.displayMessage(cmd.message, 'error');
                this._emit('command:custom', { rawCommand: text });
                return;
            default:
                this._emit('command:custom', { rawCommand: text });
                if (!this.options.managed) {
                    this.displayMessage(`I don't understand: '${text}'. Type 'help' for commands.`, 'error');
                }
        }
    }

    /**
     * Parse user input into a structured command. Three layers, in
     * order:
     *   1. Shorthand: `x` → explore; `[neswcml]\d*` → resolve against
     *      the current room's visible exits/items. Indices match what
     *      the renderer shows (cell-based when compass layout active,
     *      flat-m when not; l-based for uncollected items).
     *   2. Bare verbs: help / ? / inventory / inv / items / look.
     *   3. Verb + target: move/go/travel/to → exit; check/examine/
     *      search/inspect → item; look <name> → item (alias).
     *   4. Bare target with no verb: ambiguity-resolved against the
     *      same exit and item lists. Exact-match in both → error.
     *      Otherwise location wins to keep accidental moves rare.
     */
    _parseCommand(text, room) {
        const lower = text.toLowerCase().trim();
        if (!lower) return { type: 'error', message: 'Please enter a command.' };

        // Layer 1: shorthand.
        const sh = this._parseShorthand(lower, room);
        if (sh) return sh;

        // Layer 2: bare verbs.
        if (HELP_VERBS.includes(lower)) return { type: 'help' };
        if (INVENTORY_VERBS.includes(lower)) return { type: 'inventory' };
        if (LOOK_VERBS.includes(lower)) return { type: 'look' };

        // Layer 3: verb + target.
        const { verb, target } = this._extractVerbAndTarget(lower);
        if (verb && !target) {
            return { type: 'error', message: `Unrecognized command. Type 'help' for commands.` };
        }
        if (verb) {
            if (MOVE_VERBS.includes(verb)) {
                const matches = this._findExitMatches(room, target);
                if (matches.length === 0) return { type: 'error', message: `Unrecognized exit: ${target}` };
                return { type: 'move', exit: matches[0].exit };
            }
            if (CHECK_VERBS.includes(verb)) {
                const matches = this._findItemMatches(room, target);
                if (matches.length === 0) return { type: 'error', message: `Unrecognized item: ${target}` };
                return { type: 'examine', item: matches[0].item };
            }
            if (LOOK_VERBS.includes(verb)) {
                // "look <name>" treated as examine, matching the original substrate.
                const matches = this._findItemMatches(room, target);
                if (matches.length === 0) return { type: 'error', message: `Unrecognized item: ${target}` };
                return { type: 'examine', item: matches[0].item };
            }
            return { type: 'error', message: `Unrecognized command. Type 'help' for commands.` };
        }

        // Layer 4: bare target, ambiguity-resolved.
        const itemMatches = this._findItemMatches(room, target ?? lower);
        const exitMatches = this._findExitMatches(room, target ?? lower);
        if (itemMatches.length === 0 && exitMatches.length === 0) {
            return { type: 'error', message: `Unrecognized exit or item: ${target ?? lower}` };
        }
        const exactItem = itemMatches.find(m => m.quality === 'exact');
        const exactExit = exitMatches.find(m => m.quality === 'exact');
        if (exactItem && exactExit) {
            return {
                type: 'error',
                message: `Ambiguous name '${target ?? lower}'. Did you mean to move or examine?`,
            };
        }
        if (itemMatches.length > 0) return { type: 'examine', item: itemMatches[0].item };
        return { type: 'move', exit: exitMatches[0].exit };
    }

    /**
     * Resolve shorthand against the current room. Returns a command on
     * a match, null if input isn't a shorthand pattern, or an error
     * command if it is a shorthand pattern but the index is out of
     * range.
     */
    _parseShorthand(lower, room) {
        if (EXPLORE_RE.test(lower)) return { type: 'explore' };
        const m = SHORTHAND_RE.exec(lower);
        if (!m) return null;
        const letter = m[1];
        const digits = m[2];
        const index = digits === '' ? 1 : Number.parseInt(digits, 10);

        if (letter === 'l') {
            const items = (room.items || []).filter(it => this._isItemVisibleForShorthand(room.id, it));
            const item = items[index - 1];
            if (!item) return { type: 'error', message: `No item ${lower} in this room.` };
            return { type: 'examine', item };
        }

        if (letter === 'm') {
            const exits = (room.exits || []).filter(e => this._isExitVisibleForShorthand(room.id, e));
            const exit = exits[index - 1];
            if (!exit) return { type: 'error', message: `No exit ${lower} in this room.` };
            return { type: 'move', exit };
        }

        // n / e / s / w / c — cell-based shorthand.
        const cellId = letter.toUpperCase();
        const cells = groupExitsBySide(room.exits || []);
        const visible = (cells[cellId] || []).filter(e => this._isExitVisibleForShorthand(room.id, e));
        const exit = visible[index - 1];
        if (!exit) return { type: 'error', message: `No exit ${lower} in this room.` };
        return { type: 'move', exit };
    }

    _extractVerbAndTarget(lower) {
        const words = lower.split(/\s+/);
        if (words.length === 1) return { verb: null, target: words[0] };
        const first = words[0];
        const allVerbs = [...MOVE_VERBS, ...CHECK_VERBS, ...LOOK_VERBS];
        if (allVerbs.includes(first)) {
            return { verb: first, target: words.slice(1).join(' ') };
        }
        return { verb: null, target: lower };
    }

    _findExitMatches(room, target) {
        return findMatches(target, (room.exits || []).map(exit => ({
            entity: exit,
            keys: [exit.id, exit.label],
        }))).map(m => ({ exit: m.entity, quality: m.quality }));
    }

    _findItemMatches(room, target) {
        return findMatches(target, (room.items || []).map(item => ({
            entity: item,
            keys: [item.id, item.label],
        }))).map(m => ({ item: m.entity, quality: m.quality }));
    }

    _helpText() {
        return [
            'Commands:',
            '  go <exit> / move <exit>     — travel through an exit',
            '  examine <item> / check / search — examine an item',
            '  look                        — re-describe the current room',
            '  inventory / inv / items     — list inventory (sidebar)',
            '  explore / x                 — reveal one undiscovered thing',
            '  help / ?                    — show this text',
            '',
            'Shorthand:',
            '  n, e, s, w, c               — first exit in that compass cell',
            '  n1, e2, w3, c1              — Nth exit in that cell',
            '  m, m1, m2                   — Nth exit (flat list)',
            '  l, l1, l2                   — Nth uncollected item',
            '',
            'You can also just type the bare name of an exit or item.',
        ].join('\n');
    }

    // ─── DOM construction ──────────────────────────────────────────

    _buildDOM() {
        this.container.innerHTML = '';
        this.container.classList.add('tae-root');

        // Host-driven header bar. Hidden by default; setHeaderInfo
        // populates it (used by the wrapper for mana display).
        this._headerEl = document.createElement('div');
        this._headerEl.className = 'tae-header hidden';
        this.container.appendChild(this._headerEl);

        this._mainEl = document.createElement('div');
        this._mainEl.className = 'tae-main';
        this.container.appendChild(this._mainEl);

        this._displayEl = document.createElement('div');
        this._displayEl.className = 'tae-display';
        this._mainEl.appendChild(this._displayEl);

        this._sidebarEl = document.createElement('div');
        this._sidebarEl.className = 'tae-sidebar';
        this._sidebarEl.innerHTML = '<div class="tae-sidebar-title">Inventory</div><div class="tae-inventory-list"></div>';
        this._inventoryListEl = this._sidebarEl.querySelector('.tae-inventory-list');
        this._mainEl.appendChild(this._sidebarEl);

        const inputRow = document.createElement('div');
        inputRow.className = 'tae-input-row';
        this._input = document.createElement('input');
        this._input.type = 'text';
        this._input.className = 'tae-input';
        this._input.placeholder = 'Type a command (try: help)';
        inputRow.appendChild(this._input);
        this.container.appendChild(inputRow);

        this._pickerEl = document.createElement('div');
        this._pickerEl.className = 'tae-picker hidden';
        this.container.appendChild(this._pickerEl);
    }

    _wireInput() {
        this._displayEl.addEventListener('click', (e) => {
            const t = e.target;
            if (!(t instanceof HTMLElement)) return;
            // Click can land on the shorthand prefix span; walk up to
            // the clickable link to recover the data attrs.
            const link = t.closest('[data-exit-id], [data-item-id], [data-action]');
            if (!link) return;
            const roomId = link.dataset.roomId;
            if (link.dataset.exitId) {
                this.triggerExit(roomId, link.dataset.exitId);
                this._maybeFocus();
            } else if (link.dataset.itemId) {
                this.triggerExamineItem(roomId, link.dataset.itemId);
                this._maybeFocus();
            } else if (link.dataset.action === 'explore') {
                this.triggerExplore(roomId);
                this._maybeFocus();
            }
        });
        this._input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const text = this._input.value;
            this._input.value = '';
            this.batchUpdate(() => {
                this._queueMessage(`> ${text}`, 'user-input');
                this._handleCommand(text);
            });
        });
    }

    _maybeFocus() {
        if (this.options.autoFocusCommandInput) this.focus();
    }

    async _showInitialView() {
        if (this.world) {
            this._render();
            return;
        }
        if (this.options.managed) {
            this._displayEl.innerHTML = '<div class="tae-placeholder">Waiting for world…</div>';
            return;
        }
        // Standalone with no world: show picker.
        await this._showPicker();
    }

    async _showPicker() {
        await this._ensureManifest();
        this._pickerEl.classList.remove('hidden');
        const worlds = this._manifest?.worlds ?? [];
        this._pickerEl.innerHTML = '';

        const heading = document.createElement('div');
        heading.className = 'tae-picker-heading';
        heading.textContent = 'Select a world';
        this._pickerEl.appendChild(heading);

        if (worlds.length === 0) {
            const warn = document.createElement('div');
            warn.className = 'tae-picker-warn';
            warn.textContent = 'No worlds found in manifest.json.';
            this._pickerEl.appendChild(warn);
        }

        for (const w of worlds) {
            const btn = document.createElement('button');
            btn.className = 'tae-picker-preset';
            btn.innerHTML = `<div class="tae-picker-title">${escapeHtml(w.title || w.name)}</div>
                             <div class="tae-picker-desc">${escapeHtml(w.description || '')}</div>`;
            btn.addEventListener('click', () => {
                this.loadDefaultWorld(w.name).catch(err => {
                    this.displayMessage(`Failed to load: ${err.message}`, 'error');
                });
            });
            this._pickerEl.appendChild(btn);
        }

        const fileLabel = document.createElement('label');
        fileLabel.className = 'tae-picker-file';
        fileLabel.textContent = 'or load a world from a JSON file: ';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                this.loadWorld(JSON.parse(text));
            } catch (err) {
                this.displayMessage(`Failed to parse file: ${err.message}`, 'error');
            }
        });
        fileLabel.appendChild(fileInput);
        this._pickerEl.appendChild(fileLabel);
    }

    _hidePicker() {
        this._pickerEl?.classList.add('hidden');
    }

    // ─── rendering ─────────────────────────────────────────────────

    _queueMessage(text, kind = 'normal', opts = {}) {
        // `html: true` marks the entry as pre-escaped raw HTML so
        // styled spans (e.g. discovered-item highlights) survive
        // rendering. Defaults to plain text — escaped at render time.
        this.messages.push({ text, kind, html: !!opts.html });
        const limit = this.options.messageHistoryLimit;
        if (this.messages.length > limit) {
            this.messages = this.messages.slice(-limit);
        }
    }

    _queueRender() {
        if (this._batchDepth > 0) {
            this._renderQueued = true;
            return;
        }
        this._render();
    }

    _render() {
        // Preserve scrollback position across re-renders. If the user
        // scrolled up to read older messages, keep them there; only
        // auto-scroll to the bottom when they were already pinned to
        // the bottom (within a few px to tolerate sub-pixel layout).
        const stickToBottom = this._displayEl
            ? (this._displayEl.scrollHeight - this._displayEl.scrollTop - this._displayEl.clientHeight) < 8
            : true;

        this._renderHeader();

        if (!this.world || !this.state.currentRoomId) {
            this._displayEl.innerHTML = '<div class="tae-placeholder">No world loaded.</div>';
            this._renderInventory();
            return;
        }
        const room = this.world.rooms[this.state.currentRoomId];
        if (!room) {
            this._displayEl.innerHTML = `<div class="tae-error">Unknown room: ${this.state.currentRoomId}</div>`;
            return;
        }

        // Add room-description on first render of each new room.
        // Detect by comparing rendered room id to current. Skip in
        // managed mode — the wrapper pushes its own (possibly
        // templated) enter message via displayMessage before
        // setCurrentRoom, so the engine doesn't need to add a generic
        // line that would duplicate or replace the wrapper's prose.
        if (this._lastRenderedRoomId !== this.state.currentRoomId) {
            if (!this.options.managed) {
                this._describeRoom(room, { force: false });
            }
            this._lastRenderedRoomId = this.state.currentRoomId;
        }

        // Build the room view: messages history + exits + items
        const html = [];
        for (const m of this.messages) {
            const body = m.html ? m.text : escapeHtml(m.text).replace(/\n/g, '<br>');
            html.push(`<div class="tae-msg tae-msg-${m.kind}">${body}</div>`);
        }

        // Always show clickable exits + items panel at the bottom of the display
        html.push('<div class="tae-actions">');
        html.push(`<div class="tae-actions-title">${escapeHtml(room.title)}</div>`);

        // Exits — when any exit carries a `side` field, render a 3×3
        // compass grid (N/E/S/W cardinals + center cell C for
        // null/unsided exits). Otherwise fall back to a flat list.
        // ??? placeholders and hidden exits stay outside the
        // numbering so visible indices match what the parser sees.
        const useCompass = (room.exits || []).some(e => COMPASS_SIDES.includes(e?.side));
        if (useCompass) {
            html.push('<div class="tae-actions-label">Exits:</div>');
            html.push(this._renderExitsCompass(room));
        } else {
            const visibleExits = (room.exits || []).filter(exit => this._isExitVisibleForShorthand(room.id, exit));
            const exitItems = (room.exits || []).map(exit => {
                const idx = visibleExits.indexOf(exit);
                const shorthand = idx >= 0 ? formatFlatExitShorthand(idx, visibleExits.length) : null;
                return this._renderExit(room.id, exit, shorthand);
            }).filter(Boolean);
            if (exitItems.length > 0) {
                html.push('<div class="tae-actions-label">Exits:</div>');
                html.push('<div class="tae-actions-list">' + exitItems.join(' · ') + '</div>');
            }
        }

        // Items — assign location shorthand (l, l1, l2…) to uncollected,
        // non-??? items only. Collected items keep their label without
        // a shorthand prefix; ??? placeholders never get shorthand.
        //
        // Managed mode drops collected items from the action list
        // entirely (wrapper-driven hosts treat collection as "this
        // location is done, no need to show it again" — matching the
        // original substrate's "You can search" vs. "Already searched"
        // split). Standalone keeps them with strikethrough so the
        // player still sees what they've explored.
        const candidates = this.options.managed
            ? (room.items || []).filter(item => !this.state.items[room.id]?.[item.id]?.collected)
            : (room.items || []);
        const visibleItems = candidates.filter(item => this._isItemVisibleForShorthand(room.id, item));
        const itemEls = candidates.map(item => {
            const idx = visibleItems.indexOf(item);
            const shorthand = idx >= 0 ? formatLocationShorthand(idx, visibleItems.length) : null;
            return this._renderItem(room.id, item, shorthand);
        }).filter(Boolean);
        if (itemEls.length > 0) {
            html.push('<div class="tae-actions-label">Items:</div>');
            html.push('<div class="tae-actions-list">' + itemEls.join(' · ') + '</div>');
        }

        // Explore link (only meaningful when there's something to discover)
        if (this.options.discoveryMode === 'discovered') {
            html.push(
                '<div class="tae-actions-list tae-actions-explore">'
                + `<span class="tae-link tae-link-explore" data-room-id="${escapeHtml(room.id)}" data-action="explore">[x] explore</span>`
                + '</div>'
            );
        }

        html.push('</div>');

        this._displayEl.innerHTML = html.join('');
        if (stickToBottom) {
            this._displayEl.scrollTop = this._displayEl.scrollHeight;
        }
        this._renderInventory();
    }

    _describeRoom(room, { force }) {
        // Push the room description into the message log when entering.
        this._queueMessage(room.description || `You are in ${room.title}.`, 'normal');
    }

    _isExitVisibleForShorthand(roomId, exit) {
        const exitSlot = this.state.exits[roomId]?.[exit.id];
        const exitDiscovered = exitSlot?.discovered ?? false;
        if (this.options.discoveryMode === 'discovered' && !exitDiscovered) return false;
        return true;
    }

    _renderExitsCompass(room) {
        const cells = groupExitsBySide(room.exits || []);
        // Per-cell shorthand uses each cell's own letter (n/e/s/w/c)
        // with a 1-based index dropped when there's only one exit in
        // that cell. Only visible exits enter the count so indices
        // stay stable as discovery progresses.
        const visibleByCell = {};
        for (const cellId of COMPASS_CELLS) {
            visibleByCell[cellId] = cells[cellId].filter(e => this._isExitVisibleForShorthand(room.id, e));
        }
        const html = ['<div class="tae-exits-grid">'];
        for (const cellId of COMPASS_CELLS) {
            html.push(`<div class="tae-exits-cell tae-exits-cell-${cellId.toLowerCase()}">`);
            for (const exit of cells[cellId]) {
                const idx = visibleByCell[cellId].indexOf(exit);
                const shorthand = idx >= 0
                    ? formatCellExitShorthand(cellId, idx, visibleByCell[cellId].length)
                    : null;
                const rendered = this._renderExit(room.id, exit, shorthand);
                if (rendered) html.push(rendered);
            }
            html.push('</div>');
        }
        html.push('</div>');
        return html.join('');
    }

    _isItemVisibleForShorthand(roomId, item) {
        const slot = this.state.items[roomId]?.[item.id];
        if (!slot) return false;
        if (slot.collected) return false;
        if (this.options.discoveryMode === 'discovered' && !slot.discovered) return false;
        return true;
    }

    _renderExit(roomId, exit, shorthand) {
        const exitSlot = this.state.exits[roomId]?.[exit.id];
        const accessible = exitSlot?.accessible ?? true;
        const exitDiscovered = exitSlot?.discovered ?? false;
        const targetDiscovered = this.state.rooms[exit.targetRoomId]?.discovered ?? false;
        const discoveryMode = this.options.discoveryMode;

        // Three-state rendering when discovery mode is on:
        //   - exit not discovered             → fully obscured placeholder, click → explore
        //   - exit discovered, target unknown → show exit but obscure target name
        //   - exit discovered, target known   → full label
        if (discoveryMode === 'discovered' && !exitDiscovered) {
            return `<span class="tae-link tae-link-unknown" data-room-id="${escapeHtml(roomId)}" data-action="explore">an unfamiliar passage</span>`;
        }

        let label = exit.label;
        if (discoveryMode === 'discovered' && !targetDiscovered) {
            // The exit itself is known; the destination isn't. Show the
            // exit name but strip the parenthesised "(to X)" suffix
            // since we shouldn't reveal where it leads.
            label = exit.id + ' (unknown destination)';
        }

        const cls = ['tae-link', 'tae-link-exit'];
        cls.push(accessible ? 'tae-link-accessible' : 'tae-link-inaccessible');
        const prefix = shorthand ? `<span class="tae-shorthand">[${escapeHtml(shorthand)}]</span> ` : '';
        return `<span class="${cls.join(' ')}" data-room-id="${escapeHtml(roomId)}" data-exit-id="${escapeHtml(exit.id)}">${prefix}${escapeHtml(label)}</span>`;
    }

    _renderItem(roomId, item, shorthand) {
        const slot = this.state.items[roomId]?.[item.id];
        if (!slot) return null;
        if (this.options.discoveryMode === 'discovered' && !slot.discovered && !slot.collected) {
            // Obscured placeholder. Clicking it triggers explore for
            // the room, matching the existing substrate's behavior of
            // any "???" slot being a shortcut to explore.
            return `<span class="tae-link tae-link-unknown" data-room-id="${escapeHtml(roomId)}" data-action="explore">an unfamiliar item</span>`;
        }
        const cls = ['tae-link', 'tae-link-item'];
        if (slot.collected) cls.push('tae-link-collected');
        else if (!slot.accessible) cls.push('tae-link-inaccessible');
        else cls.push('tae-link-accessible');
        const prefix = shorthand ? `<span class="tae-shorthand">[${escapeHtml(shorthand)}]</span> ` : '';
        return `<span class="${cls.join(' ')}" data-room-id="${escapeHtml(roomId)}" data-item-id="${escapeHtml(item.id)}">${prefix}${escapeHtml(item.label)}</span>`;
    }

    _renderHeader() {
        if (!this._headerEl) return;
        const info = this._headerInfo;
        if (!info) {
            this._headerEl.classList.add('hidden');
            this._headerEl.innerHTML = '';
            return;
        }
        this._headerEl.classList.remove('hidden');
        this._headerEl.innerHTML = info.html ? info.html : escapeHtml(info.text);
    }

    _renderInventory() {
        if (!this._inventoryListEl) return;
        const ids = Object.keys(this.state.inventory);
        if (ids.length === 0) {
            this._inventoryListEl.innerHTML = '<div class="tae-inventory-empty">(empty)</div>';
            return;
        }
        this._inventoryListEl.innerHTML = ids.map(id => {
            const { count, label } = this.state.inventory[id];
            const countTxt = count > 1 ? ` <span class="tae-inventory-count">×${count}</span>` : '';
            return `<div class="tae-inventory-item">${escapeHtml(label)}${countTxt}</div>`;
        }).join('');
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Shorthand for the i-th exit in the flat list. Drops the digit when
// there's only one exit so `[m]` reads cleaner than `[m1]`.
function formatFlatExitShorthand(i, total) {
    if (total <= 1) return 'm';
    return `m${i + 1}`;
}

// Shorthand for the i-th uncollected item. Same digit-dropping rule.
function formatLocationShorthand(i, total) {
    if (total <= 1) return 'l';
    return `l${i + 1}`;
}

// Verb vocabulary. Same coverage as the original substrate parser so
// muscle-memory from there carries over.
const MOVE_VERBS = Object.freeze(['move', 'go', 'travel', 'to']);
const CHECK_VERBS = Object.freeze(['check', 'examine', 'search', 'inspect']);
const LOOK_VERBS = Object.freeze(['look']);
const INVENTORY_VERBS = Object.freeze(['inventory', 'inv', 'items', 'i']);
const HELP_VERBS = Object.freeze(['help', '?']);

// Shorthand patterns. `x` (no digit) is the explore command and is
// checked first so it isn't mistaken for an out-of-range exit.
const EXPLORE_RE = /^x$/;
const SHORTHAND_RE = /^([neswcml])(\d*)$/;

// Match `target` against a list of {entity, keys} bundles. Each key
// (id or label) is checked for exact then partial (substring) match.
// Returns matches sorted exact-first, preserving original order
// within each quality bucket.
function findMatches(target, bundles) {
    if (!target) return [];
    const t = target.toLowerCase();
    const out = [];
    for (const { entity, keys } of bundles) {
        let quality = null;
        for (const k of keys) {
            const kl = String(k ?? '').toLowerCase();
            if (kl === t) { quality = 'exact'; break; }
            if (!quality && kl.includes(t)) quality = 'partial';
        }
        if (quality) out.push({ entity, quality });
    }
    out.sort((a, b) => (a.quality === 'exact' ? -1 : 0) - (b.quality === 'exact' ? -1 : 0));
    return out;
}

// Compass cells. N/E/S/W are cardinals; C is the center cell for
// exits whose `side` is null/missing/unknown (teleporters etc.).
const COMPASS_CELLS = Object.freeze(['N', 'E', 'S', 'W', 'C']);
// Sides recognised as compass directions; anything else falls into C.
const COMPASS_SIDES = Object.freeze(['N', 'E', 'S', 'W']);
const CELL_SHORTHAND_LETTER = Object.freeze({ N: 'n', E: 'e', S: 's', W: 'w', C: 'c' });

// Bucket exits into compass cells. Preserves order within each cell.
function groupExitsBySide(exits) {
    const cells = { N: [], E: [], S: [], W: [], C: [] };
    for (const exit of (exits || [])) {
        const cell = exit && cells[exit.side] ? exit.side : 'C';
        cells[cell].push(exit);
    }
    return cells;
}

// Shorthand for the i-th exit in a compass cell.
function formatCellExitShorthand(cellId, i, total) {
    const letter = CELL_SHORTHAND_LETTER[cellId];
    if (!letter) return '';
    if (total <= 1) return letter;
    return `${letter}${i + 1}`;
}
