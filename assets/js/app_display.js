const CHANNEL_NAME = 'obs_mk_lottery_v1';
const broadcast = new BroadcastChannel(CHANNEL_NAME);

// Config
const SLOT_SIZE = 80;
const SLOT_GAP = 10;
const MAX_COLS = 10; // Default max columns before wrapping
// Single reddish yellow is handled in CSS, but for GSAP dynamic sets we use this:
const MAIN_COLOR = '#FFC000';
const MISS_COLOR = '#FF0000';
const COLORS = [
    '#FF0000', '#FF4500', '#FFA500', '#FFD700', '#FFFF00',
    '#ADFF2F', '#00FF00', '#32CD32', '#008000', '#00FA9A',
    '#00FF7F', '#00CED1', '#00BFFF', '#1E90FF', '#0000FF',
    '#8A2BE2', '#FF00FF', '#FF1493', '#C71585', '#A9A9A9'
];

// State
const playerHistories = {
    1: [],
    2: [],
    3: [],
    4: []
};
const globalUsedItems = new Set(); // Gatekeeper for Uniqueness

// Listen for messages
broadcast.onmessage = (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    switch (data.type) {
        case 'SPIN':
            handleSpin(data.payload);
            break;
        case 'RESET_GAME':
            handleReset();
            break;
        case 'RELOAD':
            window.location.reload();
            break;
        case 'UPDATE_CONFIG':
            handleUpdateConfig(data.payload);
            break;
        default:
            console.log('Unknown message type:', data.type);
    }
};

function handleUpdateConfig(payload) {
    const container = document.getElementById('movable-container');
    if (container && payload) {
        const { x, y, scale } = payload;
        container.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
}

function handleReset() {
    globalUsedItems.clear(); // Reset gatekeeper
    for (let i = 1; i <= 4; i++) {
        const container = document.getElementById(`p${i}-history`);
        container.innerHTML = '';
        playerHistories[i] = [];
    }
}

function handleSpin(payload) {
    let { playerId, resultValue, isMiss, colorIndex, resetOccurred, mode } = payload;

    // --- GATEKEEPER LOGIC ---
    if (resetOccurred) {
        globalUsedItems.clear();
    }

    if (!isMiss && resultValue) {
        if (globalUsedItems.has(resultValue)) {
            // Duplicate detected!
            // In Exhaust mode, this is strictly forbidden.
            // In Loop mode, if no reset occurred, this implies a race condition duplicate within the same cycle.
            console.warn(`[Display Gatekeeper] Prevented duplicate display of: ${resultValue}. Mode: ${mode}`);
            isMiss = true;
            resultValue = null;
        } else {
            // Valid new item
            globalUsedItems.add(resultValue);
        }
    }
    // ------------------------

    // Create DOM elements
    const container = document.getElementById(`p${playerId}-history`);
    const slotIndex = playerHistories[playerId].length;
    playerHistories[playerId].push(payload);

    // Calculate position
    const col = slotIndex % MAX_COLS;
    const row = Math.floor(slotIndex / MAX_COLS);
    const x = col * (SLOT_SIZE + SLOT_GAP);
    const y = row * (SLOT_SIZE + SLOT_GAP);

    const wrapper = document.createElement('div');
    wrapper.className = 'slot-wrapper';
    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
    wrapper.style.zIndex = 1000 - slotIndex; // Newer items behind

    const cube = document.createElement('div');
    cube.className = 'slot-cube';

    // Faces
    const faces = ['front', 'top', 'back', 'bottom'];
    const candidates = payload.candidates || [];

    // Pick random initial values for all faces
    faces.forEach(faceName => {
        const face = document.createElement('div');
        face.className = `slot-face face-${faceName}`;

        // Initial randomfill
        if (candidates.length > 0) {
            face.textContent = candidates[Math.floor(Math.random() * candidates.length)];
        } else {
            face.textContent = ''; // Empty if no candidates
        }

        cube.appendChild(face);
    });

    wrapper.appendChild(cube);
    container.appendChild(wrapper);

    // Animation via GSAP
    if (typeof gsap !== 'undefined') {
        const tl = gsap.timeline();

        // Target Total Rotation Setup for Smoothness
        // We choose N=7 spins (2520 deg) -> Fast Speed approx 387 deg/s.
        // This was the "Stable" speed before adjustments.

        const N_SPINS = 7;
        const TOTAL_DEG = N_SPINS * 360;
        const FAST_DIST = TOTAL_DEG * (10 / 13);
        const fastRotation = -FAST_DIST;
        const totalRotation = -TOTAL_DEG;

        // Variables to track rotation
        let lastRotation = 0;
        const faceMap = ['face-front', 'face-top', 'face-back', 'face-bottom'];

        const onUpdateFunc = function () {
            const currentRot = gsap.getProperty(cube, "rotationX");
            const norm = Math.abs(currentRot);

            // Update frequently every 90 degrees
            if (Math.abs(currentRot - lastRotation) >= 90) {
                lastRotation = currentRot;

                const faceIdx = Math.round(norm / 90) % 4;
                const oppositeIdx = (faceIdx + 2) % 4; // The hidden face

                const faceClass = faceMap[oppositeIdx];
                const faceEl = cube.querySelector('.' + faceClass);

                // Simple random update (No strict unique logic, as that was part of the 'complex' update)
                // But we can keep it simple as user asked to revert.
                // Reverting to basic random pick.

                if (candidates.length > 0) {
                    faceEl.textContent = candidates[Math.floor(Math.random() * candidates.length)];

                    // Reset styling in case it was used before
                    faceEl.style.color = '';
                    faceEl.style.textShadow = '';
                    faceEl.className = `slot-face ${faceClass}`; // Reset classes
                    faceEl.classList.remove('miss-mark');
                    faceEl.style.border = `4px solid ${MAIN_COLOR}`; // Enforce Yellow
                    faceEl.style.backgroundColor = 'rgba(0,0,0,0.9)';
                }
            }
        };

        // 1. Fast Spin (Linear)
        tl.to(cube, {
            duration: 5.0,
            rotationX: fastRotation,
            ease: "none",
            onUpdate: onUpdateFunc
        })
            // 2. Slow Spin (Ease Out)
            .to(cube, {
                duration: 3.0,
                rotationX: totalRotation, // Continue to total
                ease: "power1.out", // Factor 2 matches our math (10/13 vs 3/13) to prevent acceleration
                onStart: () => {
                    // Transition phase
                },
                onUpdate: function () {
                    onUpdateFunc();

                    // Logic to set FINAL result
                    // Total is -TOTAL_DEG. 
                    // Logic to set FINAL result
                    // We need to inject the result into the Front face ONLY when it is hidden (at the back).
                    // Front face is at 0 deg initially.
                    // It is at the back (hidden) when rotation is around -180, -540, -900... (odd multiples of 180).

                    const currentRot = gsap.getProperty(cube, "rotationX");
                    // We want to update it in the LAST safe window before stop.
                    // Stop is at totalRotation (multiple of 360 -> Front visible).
                    // Previous safe window (Back visible) is around totalRotation + 180.
                    // We give a window of +/- 45 degrees around the back position.

                    if (!cube.hasResultUpdated && currentRot < (totalRotation + 180 + 45) && currentRot > (totalRotation + 180 - 45)) {
                        cube.hasResultUpdated = true; // Flag to ensure single update

                        const frontEl = cube.querySelector('.face-front');
                        if (isMiss) {
                            frontEl.textContent = '';
                            frontEl.classList.add('miss-mark');
                        } else {
                            frontEl.textContent = resultValue;
                        }

                        // Style for arrival
                        frontEl.style.color = MAIN_COLOR;
                        frontEl.style.textShadow = `0 0 10px ${MAIN_COLOR}`;
                        frontEl.style.border = `4px solid ${MAIN_COLOR}`;
                        frontEl.style.backgroundColor = 'rgba(0,0,0,0.9)'; // High opacity
                        frontEl.classList.remove('miss-mark');
                        if (isMiss) frontEl.classList.add('miss-mark');
                        frontEl.classList.add('slot-result-face');

                        // Prevent random update overwriting this face anymore
                        frontEl.dataset.isFinal = "true";
                    }
                }
            })
            // 3. Stop Wait
            .to({}, { duration: 1.0 })
            // 4. Confirm
            .call(() => {
                const frontEl = cube.querySelector('.face-front');
                // Flash
                gsap.fromTo(frontEl,
                    { filter: 'brightness(3)', scale: 1.1 },
                    { filter: 'brightness(1)', scale: 1.0, duration: 0.5, ease: "elastic.out(1, 0.5)" }
                );
            });

    } else {
        // Fallback if GSAP missing
        console.warn('GSAP not found. Showing result immediately.');
        const frontFace = cube.querySelector('.face-front');
        if (isMiss) frontFace.classList.add('miss-mark');
        else frontFace.textContent = resultValue;
        frontFace.style.color = MAIN_COLOR;
        cube.style.transform = 'rotateX(0deg)';
    }
}

// Initial Sync check
console.log('Display Loaded. Waiting for Broadcast...');
