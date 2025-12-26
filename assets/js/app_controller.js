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

// Visual Logger for OBS Docks (no dev tools)
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : '✅';
    const logLine = `[${timestamp}] ${prefix} ${message}`;

    // Console
    if (type === 'error') console.error(logLine);
    else if (type === 'warn') console.warn(logLine);
    else console.log(logLine);

    // UI Panel
    const logEl = document.getElementById('logOutput');
    if (logEl) {
        logEl.innerHTML += logLine + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }
}

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
        // PROTECTION: In Exhaust Mode, we NEVER want to accept a cycle reset from a remote client
        // that might think it's in Loop Mode.
        if (payload.resetOccurred && appState.mode === 'loop') {
            appState.usedItems = [];
        }

        // Update local state from foreign spin
        if (payload.resultValue) {
            // Paranoid check to ensure we track usage even if we missed the start
            if (!appState.usedItems.includes(payload.resultValue)) {
                appState.usedItems.push(payload.resultValue);
            }
        }
        appState.playerCounts[payload.playerId] = (appState.playerCounts[payload.playerId] || 0) + 1;
        updateUI();
        // We do NOT saveState() here. We trust the sender saved it.

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
    // Deduplicate items immediately to prevent confusion
    const rawItems = rawText.split('\n').map(s => s.trim()).filter(s => s !== '');
    const uniqueItems = Array.from(new Set(rawItems));

    if (uniqueItems.length === 0) {
        alert('山札が空です！');
        return;
    }

    // Update input to reflect deduplication
    deckInput.value = uniqueItems.join('\n');

    const mode = document.querySelector('input[name="deckMode"]:checked').value;

    appState.deck = uniqueItems;
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
                // PROTECTION: Merge usedItems to prevent data loss
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
    const usedCount = appState.usedItems.length;
    const remaining = appState.deck.filter(i => !appState.usedItems.includes(i)).length;

    if (appState.mode === 'exhaust') {
        deckCountSpan.textContent = `${remaining} / ${count} (Used: ${usedCount})`;
        if (remaining === 0) deckStatus.textContent = `${modeText} Empty (Miss)`;
        else deckStatus.textContent = `${modeText} Ready`;
    } else {
        // Loop mode: show remaining in current cycle
        deckCountSpan.textContent = `${remaining} / ${count} (Cycle) (Used: ${usedCount})`;
        deckStatus.textContent = `${modeText} Ready`;
    }

    // Player buttons
    for (let i = 1; i <= 4; i++) {
        const btn = document.getElementById(`btn-p${i}`);
        if (appState.playerCounts[i] >= 20) {
            btn.disabled = true;
            btn.innerHTML = `${i}P <small>MAX</small>`;
        } else {
            // Only re-enable if not in cooldown
            if (!btn.hasAttribute('data-cooldown')) {
                btn.disabled = false;
            }
            btn.innerHTML = `${i}P <small>SPIN</small>`;
        }
    }
}

// Core Logic
// Use localStorage-based locking instead of Web Locks.
// Web Locks don't work across separate OBS browser source processes.
const LOCK_KEY = 'obs_mk_spin_lock_v1';
const LOCK_TIMEOUT = 5000; // Lock expires after 5 seconds (failsafe)

async function acquireLock() {
    const myId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const maxRetries = 10;
    const retryDelay = 100;

    for (let i = 0; i < maxRetries; i++) {
        const existing = localStorage.getItem(LOCK_KEY);
        if (existing) {
            const parsed = JSON.parse(existing);
            // Check if lock is stale (older than timeout)
            if (Date.now() - parsed.timestamp < LOCK_TIMEOUT) {
                // Lock is held by someone else, wait and retry
                await new Promise(r => setTimeout(r, retryDelay));
                continue;
            }
            // Lock is stale, we can take it
        }

        // Try to acquire lock
        const claim = { id: myId, timestamp: Date.now() };
        localStorage.setItem(LOCK_KEY, JSON.stringify(claim));

        // Wait a bit and verify we still hold the lock
        await new Promise(r => setTimeout(r, 50));

        const verify = localStorage.getItem(LOCK_KEY);
        if (verify) {
            const verifyParsed = JSON.parse(verify);
            if (verifyParsed.id === myId) {
                // We successfully acquired the lock
                log('LOCK Acquired: ' + myId.slice(-6));
                return myId;
            }
        }
        // Someone else grabbed the lock, retry
        await new Promise(r => setTimeout(r, retryDelay));
    }

    log('LOCK Failed - contention detected', 'warn');
    return null;
}

function releaseLock(myId) {
    const current = localStorage.getItem(LOCK_KEY);
    if (current) {
        const parsed = JSON.parse(current);
        if (parsed.id === myId) {
            localStorage.removeItem(LOCK_KEY);
            log('LOCK Released');
        }
    }
}

window.triggerSpin = async (playerId) => {
    // UI Cooldown
    const btn = document.getElementById(`btn-p${playerId}`);
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('data-cooldown', 'true');
    }

    // Acquire cross-process lock
    const lockId = await acquireLock();
    if (!lockId) {
        // Failed to get lock, abort
        log('SPIN Aborted - lock busy', 'warn');
        if (btn) {
            btn.removeAttribute('data-cooldown');
            btn.disabled = false;
        }
        return;
    }

    try {
        // CRITICAL: Reload state from storage inside the lock!
        loadState();

        if (appState.playerCounts[playerId] >= 20) {
            releaseLock(lockId);
            return;
        }

        // Force sync mode from UI to ensure WYSIWYG
        const currentModeEl = document.querySelector('input[name="deckMode"]:checked');
        if (currentModeEl) {
            appState.mode = currentModeEl.value;
        }

        let result = null;
        let isMiss = false;
        let resetOccurred = false;

        // Filter available
        let available = appState.deck.filter(item => !appState.usedItems.includes(item));
        log(`SPIN: 残り${available.length}枚, 使用済み: [${appState.usedItems.join(',')}]`);

        if (available.length === 0) {
            if (appState.mode === 'loop') {
                // Loop Mode: Reset usedItems and start fresh
                appState.usedItems = [];
                resetOccurred = true;
                available = [...appState.deck];
                log('ループモード: 山札リセット');
            } else {
                // Exhaust Mode: Empty -> Miss
                isMiss = true;
                log('枯渇モード: 山札切れ → ハズレ');
            }
        }

        if (!isMiss && available.length > 0) {
            // Pick a random item
            const randomIndex = Math.floor(Math.random() * available.length);
            result = available[randomIndex];

            // Final paranoid check
            if (appState.usedItems.includes(result)) {
                log(`致命的エラー: 重複検出! ${result} in [${appState.usedItems.join(',')}]`, 'error');
                // This should NEVER happen. If it does, something is very wrong.
                // Force a Miss to avoid showing duplicate
                result = null;
                isMiss = true;
            } else {
                appState.usedItems.push(result);
                log(`結果: ${result} (使用済み: ${appState.usedItems.length}/${appState.deck.length})`);
            }
        }

        // Color ID
        const colorIndex = appState.playerCounts[playerId] % 20;
        const visualCandidates = (appState.deck.length > 0) ? appState.deck : ['?'];

        const payload = {
            playerId,
            resultValue: result,
            isMiss,
            colorIndex,
            timestamp: Date.now(),
            candidates: visualCandidates,
            resetOccurred,
            mode: appState.mode
        };

        // Update State
        appState.playerCounts[playerId]++;
        saveState(); // Commit to Disk immediately
        updateUI();

        // Send
        broadcast.postMessage({
            type: 'SPIN',
            payload
        });

        console.log('[SPIN] Complete. Result:', result, 'isMiss:', isMiss);

    } finally {
        // Always release lock
        releaseLock(lockId);

        // Re-enable button after cooldown
        setTimeout(() => {
            if (btn) {
                btn.removeAttribute('data-cooldown');
                if (appState.playerCounts[playerId] < 20) {
                    btn.disabled = false;
                }
            }
        }, 300);
    }
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
