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

// OM
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

// Setup Sync Listener (To handle multiple controller tabs preventing duplicates)
broadcast.onmessage = (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'SPIN') {
        const payload = data.payload;
        // Update local state from foreign spin
        // ALWAYS track used items, even if we are locally in Loop mode currently.
        // This ensures that if we switch to Exhaust (or auto-switch via UI), we know what's gone.
        if (payload.resultValue) {
            if (!appState.usedItems.includes(payload.resultValue)) {
                appState.usedItems.push(payload.resultValue);
            }
        }
        appState.playerCounts[payload.playerId] = (appState.playerCounts[payload.playerId] || 0) + 1;
        updateUI();
        // Don't saveState() here to avoid race? strict consistency difficult without leader
        // But preventing collision is key.
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
                // PROTECTION: Don't just overwrite usedItems. Merge them.
                // This ensures that if we have "more recent" items from Broadcast that haven't hit disk yet,
                // we keep them.
                const currentUsed = new Set(appState.usedItems);
                const diskUsed = new Set(parsed.usedItems || []);

                // Union
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
            // Layout sync is separate usually but state has it
            if (parsed.layout) {
                appState.layout = { ...appState.layout, ...parsed.layout };
                // Update inputs if they match current state
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
    // In loop mode, deck is practically infinite, but we show base size
    // In exhaust mode, we show remaining
    let count = appState.deck.length;
    let modeText = appState.mode === 'exhaust' ? '[枯渇]' : '[ループ]';

    if (appState.mode === 'exhaust') {
        const remaining = appState.deck.filter(i => !appState.usedItems.includes(i)).length;
        deckCountSpan.textContent = `${remaining} / ${count}`;
        if (remaining === 0) deckStatus.textContent = `${modeText} Empty (Miss)`;
        else deckStatus.textContent = `${modeText} Ready`;
    } else {
        deckCountSpan.textContent = `${count}`;
        deckStatus.textContent = `${modeText} Ready`;
    }

    // Player buttons
    for (let i = 1; i <= 4; i++) {
        const btn = document.getElementById(`btn-p${i}`);
        if (appState.playerCounts[i] >= 20) {
            btn.disabled = true;
            btn.innerHTML = `${i}P <small>MAX</small>`;
        } else {
            btn.disabled = false;
            btn.innerHTML = `${i}P <small>SPIN</small>`;
        }
    }
}

// Core Logic
window.triggerSpin = (playerId) => {
    // USE WEB LOCKS API for atomic transactions across multiple tabs/docks.
    navigator.locks.request('obs_mk_spin_lock', async (lock) => {
        // CRITICAL: Always reload state from storage before acting.
        // This prevents race conditions where rapid clicks use stale memory state.
        loadState();

        if (appState.playerCounts[playerId] >= 20) return;

        // Force sync mode from UI to ensure WYSIWYG
        const currentModeEl = document.querySelector('input[name="deckMode"]:checked');
        if (currentModeEl) {
            appState.mode = currentModeEl.value;
        }

        let result = null;
        let isMiss = false;

        // Strict Retry Loop for Uniqueness
        // We try up to 3 times to get a valid result if something weird happens, 
        // although filtering should guarantee it.
        let attempts = 0;
        let validPick = false;
        let available = [];

        while (!validPick && attempts < 3) {
            attempts++;

            // Filter available items if exhaust
            available = [...appState.deck];
            if (appState.mode === 'exhaust') {
                available = available.filter(item => !appState.usedItems.includes(item));
            }

            if (available.length === 0) {
                // Empty
                if (appState.mode === 'loop') {
                    isMiss = true;
                    validPick = true;
                } else {
                    // Exhaust mode empty -> Miss
                    isMiss = true;
                    validPick = true;
                }
            } else {
                // Random pick
                const randomIndex = Math.floor(Math.random() * available.length);
                result = available[randomIndex];

                // Paranoid Check for Exhaust Mode
                if (appState.mode === 'exhaust') {
                    if (appState.usedItems.includes(result)) {
                        console.warn('Duplicate detected during pick, retrying...', result);
                        result = null; // Retry
                        continue;
                    } else {
                        appState.usedItems.push(result);
                        validPick = true;
                    }
                } else {
                    validPick = true;
                }
            }
        }

        // Color ID: Simple hashing or random? 
        // "配色はインデックス順" from spec 2.3 usually means 0..19 loop based on history count?
        // "抽選結果の文字色・背景色として、以下の20色をインデックス順に使用する"
        // Does it mean fixed color for "Item A", or "1st spin is Red, 2nd is Orange"?
        // Usually Mario Kart is random or item-based.
        // Spec says "Index 0..19". Let's use the local player history count for rainbow effect.
        // Color ID: Simple hashing loop
        const colorIndex = appState.playerCounts[playerId] % 20;

        // Visual Candidates:
        // Even if it's a "Miss" (result is effectively null), we want the cube to visually rotate through options.
        // If available is empty, we must fallback to the full deck for the animation.
        const visualCandidates = (available.length > 0) ? available : appState.deck;

        const payload = {
            playerId,
            resultValue: result, // Null if Miss
            isMiss,
            colorIndex,
            timestamp: Date.now(),
            candidates: visualCandidates.length > 0 ? visualCandidates : ['?'] // Fallback if deck is empty too
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
