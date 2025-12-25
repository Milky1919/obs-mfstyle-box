const CHANNEL_NAME = 'obs_mk_lottery_v1';
const broadcast = new BroadcastChannel(CHANNEL_NAME);
const STORAGE_KEY = 'obs_mk_lottery_data_v1';

// State
let appState = {
    deck: [],
    usedItems: [],
    playerCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    mode: 'loop', // or 'exhaust'
    history: [], // Global event history
    layout: { x: 0, y: 0, scale: 1.0 } // Default layout
};

// DOM Elements
const deckInput = document.getElementById('deckInput');
const deckStatus = document.getElementById('deckStatus');
const deckCountSpan = document.getElementById('deckCount');
const posXInput = document.getElementById('posX');
const posYInput = document.getElementById('posY');
const scaleInput = document.getElementById('scale');

// Init
window.addEventListener('DOMContentLoaded', () => {
    loadState();
    updateUI();
});

// Setup Sync Listener
broadcast.onmessage = (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'SPIN') {
        const payload = data.payload;

        // Handle Loop Mode Auto-Reset Sync
        if (payload.resetOccurred) {
            appState.usedItems = [];
        }

        // Update local state from foreign spin
        if (payload.resultValue) {
            if (!appState.usedItems.includes(payload.resultValue)) {
                appState.usedItems.push(payload.resultValue);
            }
        }
        appState.playerCounts[payload.playerId] = (appState.playerCounts[payload.playerId] || 0) + 1;
        updateUI();
        // Note: We don't saveState() here immediately to avoid potential race conditions with the sender,
        // but the sender has already saved to localStorage.
    } else if (data.type === 'RESET_GAME') {
        appState.usedItems = [];
        appState.playerCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
        updateUI();
    } else if (data.type === 'SYNC_STATE') {
        loadState();
        updateUI();
    }
};

// Save Deck Config
document.getElementById('saveDeckBtn').addEventListener('click', () => {
    const rawText = deckInput.value;
    const items = rawText.split('\n').map(s => s.trim()).filter(s => s !== '');

    if (items.length === 0) {
        alert('山札が空です！');
        return;
    }

    const mode = document.querySelector('input[name="deckMode"]:checked').value;

    appState.deck = items;
    appState.mode = mode;
    appState.usedItems = [];
    appState.playerCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

    // Also reset the game
    resetGame(true); // Argument true to skip confirmation inside

    // Broadcast state update to sync other tabs
    broadcast.postMessage({ type: 'SYNC_STATE' });
});

function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // Merge basic fields
            if (parsed.deck) {
                // PROTECTION: Merge usedItems to prevent data loss if disk has more info
                const currentUsed = new Set(appState.usedItems);
                const diskUsed = new Set(parsed.usedItems || []);
                const mergedUsed = new Set([...currentUsed, ...diskUsed]);

                appState = { ...appState, ...parsed };
                appState.usedItems = Array.from(mergedUsed);

                // Restore input value
                if (appState.deck.length > 0) {
                    deckInput.value = appState.deck.join('\n');
                }
                // Check radio
                const rad = document.querySelector(`input[name="deckMode"][value="${appState.mode}"]`);
                if (rad) rad.checked = true;
            }
            // Layout sync
            if (parsed.layout) {
                appState.layout = { ...appState.layout, ...parsed.layout };
                if (posXInput) posXInput.value = appState.layout.x;
                if (posYInput) posYInput.value = appState.layout.y;
                if (scaleInput) scaleInput.value = appState.layout.scale;
            }
        } catch (e) {
            console.error('Save data corrupt', e);
        }
    }
}

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    updateUI();
}

function updateUI() {
    // Deck count
    let count = appState.deck.length;
    let modeText = appState.mode === 'exhaust' ? '[枯渇]' : '[ループ]';

    // Calculate remaining items
    const remaining = appState.deck.filter(i => !appState.usedItems.includes(i)).length;

    if (appState.mode === 'exhaust') {
        deckCountSpan.textContent = `${remaining} / ${count}`;
        if (remaining === 0) deckStatus.textContent = `${modeText} Empty (Miss)`;
        else deckStatus.textContent = `${modeText} Ready`;
    } else {
        // Loop mode: show remaining in current cycle
        deckCountSpan.textContent = `${remaining} / ${count} (Cycle)`;
        deckStatus.textContent = `${modeText} Ready`;
    }

    // Player buttons
    for (let i = 1; i <= 4; i++) {
        const btn = document.getElementById(`btn-p${i}`);
        if (appState.playerCounts[i] >= 20) {
            btn.disabled = true;
            btn.innerHTML = `${i}P <small>MAX</small>`;
        } else {
            // Only re-enable if not in cooldown (checked via disabled attribute logic in triggerSpin)
            // But here we might overwrite it.
            // Better strategy: Only disable if MAX. If we want to handle cooldown, we should check if it's currently in cooldown?
            // For simplicity, we assume updateUI is called after Spin finishes or on load.
            // If we are in the middle of a cooldown, this might re-enable it prematurely if called from elsewhere.
            // However, updateUI is usually called after state change.
            if (!btn.hasAttribute('data-cooldown')) {
                 btn.disabled = false;
            }
            btn.innerHTML = `${i}P <small>SPIN</small>`;
        }
    }
}

// Core Logic
window.triggerSpin = (playerId) => {
    // UI Cooldown to prevent physical spam
    const btn = document.getElementById(`btn-p${playerId}`);
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('data-cooldown', 'true');
        setTimeout(() => {
            if (btn) {
                btn.removeAttribute('data-cooldown');
                if (appState.playerCounts[playerId] < 20) {
                    btn.disabled = false;
                }
            }
        }, 500);
    }

    // USE WEB LOCKS API for atomic transactions
    navigator.locks.request('obs_mk_spin_lock', async (lock) => {
        // NOTE: We REMOVED loadState() here to trust the in-memory state.
        // This prevents overwriting recent in-memory updates with stale disk data during rapid interactions.

        if (appState.playerCounts[playerId] >= 20) return;

        // Force sync mode from UI to ensure WYSIWYG
        const currentModeEl = document.querySelector('input[name="deckMode"]:checked');
        if (currentModeEl) {
            appState.mode = currentModeEl.value;
        }

        let result = null;
        let isMiss = false;
        let resetOccurred = false;

        // Determine available candidates
        let available = appState.deck.filter(item => !appState.usedItems.includes(item));

        if (available.length === 0) {
            if (appState.mode === 'loop') {
                // Loop Mode: Reset usedItems and start fresh
                appState.usedItems = [];
                resetOccurred = true;

                // Refill available
                available = [...appState.deck];

                if (available.length === 0) {
                    // Deck is empty (user deleted all items?)
                    isMiss = true;
                } else {
                    // Pick one
                    const randomIndex = Math.floor(Math.random() * available.length);
                    result = available[randomIndex];
                    appState.usedItems.push(result);
                }
            } else {
                // Exhaust Mode: Empty -> Miss
                isMiss = true;
            }
        } else {
            // Normal Pick
            const randomIndex = Math.floor(Math.random() * available.length);
            result = available[randomIndex];
            appState.usedItems.push(result);
        }

        // Color ID
        const colorIndex = appState.playerCounts[playerId] % 20;

        // Visual Candidates: For animation purposes
        // If we just reset, use full deck. If not, use available (before pick) or deck.
        const visualCandidates = (appState.deck.length > 0) ? appState.deck : ['?'];

        const payload = {
            playerId,
            resultValue: result, // Null if Miss
            isMiss,
            colorIndex,
            timestamp: Date.now(),
            candidates: visualCandidates,
            resetOccurred // Notify others that we reset the cycle
        };

        // Update State
        appState.playerCounts[playerId]++;
        saveState();

        // Send
        broadcast.postMessage({
            type: 'SPIN',
            payload
        });
    });
};

window.resetGame = (skipConfirm = false) => {
    if (!skipConfirm && !confirm('本当にリセットしますか？')) return;

    // Reset runtime state but keep deck config
    appState.usedItems = [];
    appState.playerCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    saveState();

    broadcast.postMessage({ type: 'RESET_GAME' });
};

window.reloadDisplay = () => {
    broadcast.postMessage({ type: 'RELOAD' });
    // Resend layout after reload
    setTimeout(() => updateLayout(), 500);
};

window.updateLayout = () => {
    const x = parseFloat(posXInput.value) || 0;
    const y = parseFloat(posYInput.value) || 0;
    const scale = parseFloat(scaleInput.value) || 1.0;

    appState.layout = { x, y, scale };
    saveState();

    broadcast.postMessage({
        type: 'UPDATE_CONFIG',
        payload: appState.layout
    });
};
