// The number of outputs we ask the browser to merge into one multichannel stream.
// Keep this at 24 for the real installation, but allow a stereo preview mode for testing.
const NUM_OUTPUTS = 24;
const PRESET_URL = 'presets.json';

// Grab DOM elements by their IDs so we can update the page from JavaScript.
const presetSelect = document.getElementById('presetSelect');
const durationInput = document.getElementById('durationInput');
const durationValue = document.getElementById('durationValue');
const stereoPreviewCheckbox = document.getElementById('stereoPreview');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const infoText = document.getElementById('infoText');
const outputText = document.getElementById('outputText');
const slidersContainer = document.getElementById('sliders');

let presets = {}; // Loaded presets from presets.json.
let originalPresets = null; // Keep an immutable copy to allow reset to defaults
let audioContext = null; // Single AudioContext for the page.
let currentPresetName = null; // The selected preset key.
let currentDuration = 8.0; // Duration in seconds for playback.
let stereoPreviewEnabled = false; // Toggle stereo preview while keeping the default multichannel graph.
let channels = []; // Array of channel objects for each sine partial.
let channelSettings = []; // Current slider settings, used before and during playback.
let mergerNode = null; // The 24-input ChannelMergerNode.
let masterGain = null; // The final gain before audio output.
let stopTimeoutId = null; // Timeout used to clean up after the preset duration.
let adsrEnvelope = null; // Holds our interactive Nexus.Envelope instance
let magMultislider = null; // 👈 Add this here globally
let adsrSetInProgress = false; // Guard to avoid recursion when we call setPoints
let adsrInteractiveEnabled = false; // Controlled by UI checkbox; default false to act as visualizer only
const ADSR_HOLD = 0.5; // visual sustain plateau length in seconds (kept consistent)

function setEnvelopeFromPreset(preset) {
    if (!adsrEnvelope || !preset?.adsr) return;
    const p = preset.adsr;
    const attack = p.attack_time ?? 0.1;
    const decay = p.decay_time ?? 0.4;
    const sustain_level = p.sustain_level ?? 0.7;
    const release = p.release_time ?? 0.4;
    const hold = ADSR_HOLD;
    const total = attack + decay + hold + release;
    const pt1 = attack / total;
    const pt2 = pt1 + decay / total;
    const pt3 = pt2 + hold / total;

    const pts = [
        { x: 0.0, y: 0.0 },
        { x: pt1, y: 1.0 },
        { x: pt2, y: sustain_level },
        { x: pt3, y: sustain_level },
        { x: 1.0, y: 0.0 }
    ];

    try {
        adsrSetInProgress = true;
        adsrEnvelope.setPoints(pts);
    } catch (err) {
        console.warn('Failed to set envelope from preset:', err);
    } finally {
        setTimeout(() => { adsrSetInProgress = false; }, 0);
    }
}
// Convert a UI slider dB value (-60 to 0) into a Web Audio gain multiplier (0 to 1)
function dbToLinear(db) {
    if (db <= -60) return 0; // Completely silence the channel at the bottom
    return Math.pow(10, db / 20);
}

// Convert a preset linear magnitude (0 to 1) into a UI dB value (-60 to 0)
function linearToDb(linear) {
    if (linear <= 0.001) return -60; // Floor it out to prevent negative infinity errors
    return 20 * Math.log10(linear);
}
// Load presets.json and fill the preset selector.
async function loadPresets() {
    try {
        const response = await fetch(PRESET_URL); // Fetch the JSON file.
        if (!response.ok) {
            throw new Error(`Could not load presets: ${response.status}`);
        }

        presets = await response.json(); // Parse the JSON.
        // Keep a deep copy of the originals so 'reset to default' can restore them even after in-session edits
        originalPresets = JSON.parse(JSON.stringify(presets));
        const presetNames = Object.keys(presets); // Get preset keys.

        if (!presetNames.length) {
            throw new Error('No presets found in presets.json');
        }

        // Create one <option> for each preset.
        presetNames.forEach((key) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = presets[key].name || key;
            presetSelect.appendChild(option);
        });

        currentPresetName = presetNames[0]; // Pick the first preset by default.
        presetSelect.value = currentPresetName;

        presetSelect.addEventListener('change', () => {
            currentPresetName = presetSelect.value; // Update selected preset.
            updatePresetUI(presets[currentPresetName]); // Rebuild the sliders.
        });

        durationInput.addEventListener('input', () => {
            currentDuration = Number(durationInput.value);
            durationValue.textContent = `${currentDuration.toFixed(1)}s`;
        });

        stereoPreviewCheckbox.addEventListener('change', () => {
            stereoPreviewEnabled = stereoPreviewCheckbox.checked;

            if (currentPresetName && presets[currentPresetName]) {
                if (channels.length > 0) {
                    cleanupAudioGraph();
                    createAudioGraph(presets[currentPresetName]);
                    startButton.disabled = true;
                    stopButton.disabled = false;
                    outputText.textContent = stereoPreviewEnabled
                        ? `Stereo preview for ${presets[currentPresetName].name}.`
                        : `Playing ${presets[currentPresetName].name} for ${currentDuration.toFixed(1)}s.`;
                } else {
                    outputText.textContent = stereoPreviewEnabled
                        ? 'Stereo preview enabled.'
                        : 'Multichannel output enabled.';
                }
            }
        });

        resetButton.addEventListener('click', () => {
            if (!currentPresetName) return;
            // Restore the preset object from the original copy, then update the UI (this also resets ADSR visualizer)
            if (originalPresets && originalPresets[currentPresetName]) {
                presets[currentPresetName] = JSON.parse(JSON.stringify(originalPresets[currentPresetName]));
            }
            updatePresetUI(presets[currentPresetName]); // Reload preset defaults without changing selection.
        });

        updatePresetUI(presets[currentPresetName]); // Show the first preset in the UI.
        infoText.textContent = `Loaded ${presetNames.length} presets from presets.json.`;
    } catch (error) {
        infoText.textContent = `Error loading presets: ${error.message}`;
        console.error(error); // Print error details to the console.
    }
}

// Build the slider UI for the selected preset.
function updatePresetUI(preset) {
    const wasPlaying = !stopButton.disabled; // Remember if audio was active.
    slidersContainer.innerHTML = ''; // Clear old sliders.
    resetChannelSettings(preset); // Restore the preset defaults for sliders.

    const frequencies = preset.frequencies || [];
    const magnitudes = preset.magnitudes || [];
    const adsr = preset.adsr || {};
    const vibrato = preset.vibrato || {};
    const amplitudeMod = preset.amplitude_modulation || {};

    frequencies.forEach((frequency, index) => {
        const magnitude = magnitudes[index] ?? 0.0; // Default volume for this partial.
        channelSettings[index] = { desiredFrequency: frequency, desiredMagnitude: magnitude };

        // 1. CREATE ALL DOM ELEMENTS FIRST
        const row = document.createElement('div');
        row.className = 'slider-row';

        const label = document.createElement('label');
        label.textContent = `Channel ${index + 1}: ${frequency.toFixed(1)} Hz`;

        const frequencyLabel = document.createElement('div');
        frequencyLabel.textContent = 'Frequency';
        frequencyLabel.className = 'slider-label';

        const frequencyValue = document.createElement('span');
        frequencyValue.className = 'slider-value';
        frequencyValue.textContent = frequency.toFixed(1);
        
        const nexusSliderPlaceholder = document.createElement('div');
        nexusSliderPlaceholder.id = `freq-slider-container-${index}`;

        const magnitudeLabel = document.createElement('div');
        magnitudeLabel.textContent = 'Magnitude';
        magnitudeLabel.className = 'slider-label';

        const magnitudeValue = document.createElement('span');
        magnitudeValue.className = 'slider-value';
        magnitudeValue.textContent = magnitude.toFixed(3);

        const nexusMagPlaceholder = document.createElement('div');
        nexusMagPlaceholder.id = `mag-slider-container-${index}`;
        


        // 3. APPEND EVERYTHING TO THE ROW IN THE CORRECT LAYOUT ORDER
        row.appendChild(label);
        row.appendChild(frequencyLabel);
        row.appendChild(nexusSliderPlaceholder); 
        row.appendChild(frequencyValue);
        row.appendChild(magnitudeLabel);
        // row.appendChild(nexusMagPlaceholder); // 👈 New placeholder injected here
        //row.appendChild(magSlider);              
        // row.appendChild(magnitudeValue); comenting out to
        // avoid displaying the magnitude value and doing a multislider
        
        // 4. INJECT THE COMPLETE ROW INTO THE CONTAINER
        slidersContainer.appendChild(row);

        // 5. NOW INITIALIZE NEXUSUI (Passing the raw ID string without '#')
        const freqSlider = new Nexus.Slider(`freq-slider-container-${index}`, {
            size: [90, 25], 
            min: frequency * 0.75,
            max: frequency * 1.25,
            step: Math.max(0.1, frequency * 0.001),
            value: frequency
        });
        
        freqSlider.colorize("accent", "#3498db");

        freqSlider.on('change', (value) => {
            console.log(value);

            frequencyValue.textContent = value.toFixed(1);
            channelSettings[index].desiredFrequency = value;

            if (channels[index] && channels[index].osc) {
                channels[index].osc.frequency.value = value;
            }
        });
        // // 5. INITIALIZE MAGNITUDE SLIDER
        // const magSlider = new Nexus.Slider(`mag-slider-container-${index}`, {
        //     size: [120, 25], 
        //     min: 0,
        //     max: 1,
        //     step: 0.001,
        //     value: magnitude
        // });
        // magSlider.colorize("accent", "#7d9bff"); // Gives it a distinct purple/indigo color
        
        // magSlider.on('change', (value) => {
        //     magnitudeValue.textContent = value.toFixed(3);
        //     channelSettings[index].desiredMagnitude = value;

        //     if (channels[index] && channels[index].sliderGain) {
        //         const gainParam = channels[index].sliderGain.gain;
        //         const now = audioContext?.currentTime || 0;
        //         gainParam.cancelScheduledValues(now);
        //         gainParam.setValueAtTime(gainParam.value, now);
        //         gainParam.linearRampToValueAtTime(value, now + 0.02);
        //     }
        // });
    });
    // 1. Target your new HTML container
    const multisliderContainer = document.getElementById('magnitude-multislider');
    multisliderContainer.innerHTML = ''; // Clear it out when switching presets

    if (typeof Nexus === 'undefined') {
        infoText.textContent = 'NexusUI library not loaded. Multislider unavailable.';
        console.error('NexusUI is undefined. Cannot create Multislider.');
        return;
    }

    const dbValues = magnitudes.map(mag => linearToDb(mag));
    // 2. Initialize the Multislider component
    magMultislider = new Nexus.Multislider(multisliderContainer, {
        size: [600, 200],         // [Width, Height] - Make it wide and tall!
        numberOfSliders: frequencies.length, // Automatically scales to match your preset (e.g., 24)
        min: -60,
        max: 0,
        step: 0.001,
        values: dbValues       // Automatically sets the starting bars to your preset volumes!
    });

    magMultislider.colorize("accent", "#d76315");

    magMultislider.on('change', (matrixValues) => {
    // Since 'matrixValues' is a raw array of 24 numbers, we loop through all of them    
    console.log(matrixValues);
    matrixValues.forEach((newDb, channelIndex) => {
        const linearMagnitude = dbToLinear(newDb);
        if (channelSettings[channelIndex]) {
            channelSettings[channelIndex].desiredMagnitude = linearMagnitude;
        }
        //2 adjust the live audio volum node
        if (channels[channelIndex] && channels[channelIndex].sliderGain) {
            const gainParam = channels[channelIndex].sliderGain.gain;
            const now = audioContext?.currentTime || 0;
            
            gainParam.cancelScheduledValues(now);
            gainParam.setValueAtTime(gainParam.value, now);
            gainParam.linearRampToValueAtTime(linearMagnitude, now + 0.02);
        }
        });
    });
    // Synchronize visual ADSR graph coordinates with the loaded preset data
    if (adsrEnvelope && preset.adsr) {
        setEnvelopeFromPreset(preset);
    }



    const sampleRate = preset.audio_settings?.sr || 44100;
    const duration = preset.audio_settings?.duration || 8.0;
    currentDuration = duration;
    durationInput.value = String(currentDuration);
    durationValue.textContent = `${currentDuration.toFixed(1)}s`;
    infoText.textContent = `Preset: ${preset.name} · Sample rate: ${sampleRate} Hz · Duration: ${currentDuration.toFixed(1)}s`;
    outputText.textContent = `ADSR ${adsr.attack_time || 0.0}/${adsr.decay_time || 0.0}/${adsr.sustain_level || 0.0}/${adsr.release_time || 0.0}s · Vibrato ${vibrato.frequency || 0.0}Hz @${vibrato.magnitude || 0.0} · AM ${amplitudeMod.frequency || 0.0}Hz @${amplitudeMod.depth || 0.0}`;

    if (wasPlaying) {
        fadeOutAndCleanup(0.02).then(() => {
            createAudioGraph(preset); // Restart audio using the restored preset defaults.
            startButton.disabled = true;
            stopButton.disabled = false;
            outputText.textContent = `Playing ${preset.name} for ${duration}s.`;
        });
    }
}

// Create or return the same AudioContext each time.
function getAudioContext(sampleRate) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    }
    return audioContext;
}

// Reset the stored frequency + magnitude sliders to the preset defaults.
function resetChannelSettings(preset) {
    channelSettings = [];
    const frequencies = preset.frequencies || [];
    const magnitudes = preset.magnitudes || [];
    frequencies.forEach((frequency, index) => {
        channelSettings[index] = {
            desiredFrequency: frequency,
            desiredMagnitude: magnitudes[index] ?? 0.0,
        };
    });
}

// Stop and disconnect all active audio nodes cleanly.
function cleanupAudioGraph() {
    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }

    channels.forEach((channel) => {
        try {
            channel.osc.stop();
        } catch (error) {
            // Already stopped, ignore.
        }
        try {
            channel.vibOsc.stop();
        } catch (error) {
            // Already stopped, ignore.
        }
        try {
            channel.amOsc.stop();
        } catch (error) {
            // Already stopped, ignore.
        }

        channel.osc.disconnect();
        channel.vibOsc.disconnect();
        channel.amOsc.disconnect();
        channel.sliderGain.disconnect();
        channel.amGain.disconnect();
        channel.envGain.disconnect();
        if (channel.panner) {
            channel.panner.disconnect();
        }
    });

    if (mergerNode) {
        mergerNode.disconnect();
        mergerNode = null;
    }
    if (masterGain) {
        masterGain.disconnect();
        masterGain = null;
    }

    channels = []; // Reset channel array.
    startButton.disabled = false; // Allow start again.
    stopButton.disabled = true; // Disable stop until next play.
}

function fadeOutAndCleanup(fadeDuration = 0.02) {
    return new Promise((resolve) => {
        if (!audioContext || !masterGain) {
            cleanupAudioGraph();
            resolve();
            return;
        }

        const now = audioContext.currentTime;
        masterGain.gain.cancelScheduledValues(now);
        masterGain.gain.setValueAtTime(masterGain.gain.value, now);
        masterGain.gain.linearRampToValueAtTime(0.0, now + fadeDuration);

        if (stopTimeoutId) {
            clearTimeout(stopTimeoutId);
            stopTimeoutId = null;
        }

        setTimeout(() => {
            cleanupAudioGraph();
            resolve();
        }, Math.max(20, fadeDuration * 1000 + 10));
    });
}

// Build the full audio graph for the selected preset.
function createAudioGraph(preset) {
    const context = getAudioContext(preset.audio_settings?.sr || 44100);
    const duration = currentDuration;
    const livePresetData = presets[currentPresetName] || preset;
    const adsr = {
        attack_time: Math.max(livePresetData.adsr?.attack_time ?? 0.01, 0.01),
        decay_time: livePresetData.adsr?.decay_time ?? 0.6,
        sustain_level: livePresetData.adsr?.sustain_level ?? 0.7,
        release_time: Math.max(livePresetData.adsr?.release_time ?? 0.01, 0.01),
    };

    const vibrato = {
        frequency: livePresetData.vibrato?.frequency ?? 4.0,
        magnitude: livePresetData.vibrato?.magnitude ?? 0.11,
        attack_time: livePresetData.vibrato?.attack_time ?? 2.0,
    };

    const amplitudeMod = {
        frequency: livePresetData.amplitude_modulation?.frequency ?? 5.0,
        depth: livePresetData.amplitude_modulation?.depth ?? 0.065,
    };

    masterGain = context.createGain(); // Final output gain.
    masterGain.gain.value = 0.35; // Keep overall loudness reasonable.
    masterGain.connect(context.destination); // Send master to speakers.

    if (!stereoPreviewEnabled) {
        mergerNode = context.createChannelMerger(NUM_OUTPUTS); // Create 24 input channels for the real multichannel path.
        mergerNode.channelCountMode = 'explicit';
        mergerNode.channelInterpretation = 'discrete';
        mergerNode.connect(masterGain); // Merge 24 channels into master.
    }

    const frequencies = preset.frequencies || [];
    const magnitudes = preset.magnitudes || [];

    const startTime = context.currentTime + 0.05; // Slight future start time.
    const endTime = startTime + duration;
    const attackEnd = startTime + adsr.attack_time;
    const decayEnd = attackEnd + adsr.decay_time;
    const releaseStart = Math.max(endTime - adsr.release_time, decayEnd);

    frequencies.forEach((frequency, index) => {
        const desiredFrequency = channelSettings[index]?.desiredFrequency ?? frequency;
        const desiredMagnitude = channelSettings[index]?.desiredMagnitude ?? (magnitudes[index] ?? 0.0);

        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = desiredFrequency; // Use the current slider frequency.

        const sliderGain = context.createGain();
        sliderGain.gain.value = desiredMagnitude; // Use the current slider magnitude.

        const amGain = context.createGain();
        amGain.gain.setValueAtTime(1.0, startTime); // Base amplitude modulation envelope.

        const amOsc = context.createOscillator();
        amOsc.type = 'sine';
        amOsc.frequency.value = amplitudeMod.frequency;

        const amOscGain = context.createGain();
        amOscGain.gain.value = amplitudeMod.depth;
        amOsc.connect(amOscGain).connect(amGain.gain); // AM oscillator modulates the gain.

        const envGain = context.createGain();
        envGain.gain.setValueAtTime(0.0, startTime); // Start silent.
        envGain.gain.linearRampToValueAtTime(1.0, attackEnd); // Attack up.
        envGain.gain.linearRampToValueAtTime(adsr.sustain_level, decayEnd); // Decay to sustain.
        envGain.gain.setValueAtTime(adsr.sustain_level, releaseStart); // Hold sustain.
        envGain.gain.linearRampToValueAtTime(0.0, endTime); // Release down.

        let panner = null;
        if (stereoPreviewEnabled) {
            panner = context.createStereoPanner();
            panner.pan.value = frequencies.length > 1 ? ((index / (frequencies.length - 1)) * 2 - 1) : 0;
            osc.connect(sliderGain).connect(amGain).connect(envGain).connect(panner).connect(masterGain);
        } else {
            // Signal path for the normal multichannel setup: oscillator -> slider gain -> AM -> envelope -> merger channel.
            osc.connect(sliderGain).connect(amGain).connect(envGain).connect(mergerNode, 0, index);
        }

        const vibOsc = context.createOscillator();
        vibOsc.type = 'sine';
        vibOsc.frequency.value = vibrato.frequency;

        const vibGain = context.createGain();
        vibGain.gain.setValueAtTime(0.0, startTime);
        vibGain.gain.linearRampToValueAtTime(vibrato.magnitude, startTime + vibrato.attack_time);
        vibOsc.connect(vibGain).connect(osc.frequency); // Vibrato modulates oscillator frequency.

        channels.push({
            osc,
            vibOsc,
            amOsc,
            sliderGain,
            amGain,
            envGain,
            panner,
        });

        osc.start(startTime);
        vibOsc.start(startTime);
        amOsc.start(startTime);

        osc.stop(endTime + 0.05);
        vibOsc.stop(endTime + 0.05);
        amOsc.stop(endTime + 0.05);
    });

    stopTimeoutId = setTimeout(() => {
        cleanupAudioGraph();
        outputText.textContent = 'Audio finished.';
    }, (duration + 0.1) * 1000);
}

// Start audio playback for the current preset.
function startAudio() {
    if (!currentPresetName) {
        return; // Nothing selected.
    }

    const preset = presets[currentPresetName];
    if (!preset) {
        infoText.textContent = 'Preset not found.';
        return;
    }

    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume(); // Resume if the context was paused.
    }

    cleanupAudioGraph(); // Remove any previous audio graph.
    createAudioGraph(preset); // Build a fresh graph.

    startButton.disabled = true;
    stopButton.disabled = false;
    outputText.textContent = `Playing ${preset.name} for ${preset.audio_settings?.duration ?? 8.0}s.`;
}

// Stop the running audio and reset the UI.
function stopAudio() {
    if (stopTimeoutId) {
        clearTimeout(stopTimeoutId);
        stopTimeoutId = null;
    }

    fadeOutAndCleanup(0.02);
    outputText.textContent = 'Audio stopped.';
}

// Restart audio from the current preset when the UI changes.
function restartAudio() {
    if (channels.length > 0) {
        startAudio();
    }
}

startButton.addEventListener('click', startAudio); // Play button.
stopButton.addEventListener('click', stopAudio); // Stop button.

// --- FIX: WAIT FOR THE DOM TO BE READY BEFORE DOING ANYTHING ---
function initUI() {
    // Verify NexusUI is available before creating widgets
    if (typeof Nexus === 'undefined') {
        infoText.textContent = 'NexusUI library not loaded. Check the script tag in index.html.';
        console.error('NexusUI is undefined. Ensure the NexusUI script is included.');
        return;
    }

    // 1. Initialize the global ADSR Envelope safely
    adsrEnvelope = new Nexus.Envelope('envelope-container', {
        size: [382, 102], 
        noUi: false,      
        points: [         
            { x: 0.0, y: 0.0 },  
            { x: 0.1, y: 1.0 },  
            { x: 0.3, y: 0.7 },  
            { x: 0.8, y: 0.7 },  
            { x: 1.0, y: 0.0 }   
        ]
    });

    // Wire interactive checkbox
    const adsrInteractiveCheckbox = document.getElementById('adsrInteractive');
    if (adsrInteractiveCheckbox) {
        adsrInteractiveEnabled = adsrInteractiveCheckbox.checked;
        // Toggle pointer-events on the envelope container
        const envContainer = document.getElementById('envelope-container');
        if (envContainer) envContainer.style.pointerEvents = adsrInteractiveEnabled ? 'auto' : 'none';
        adsrInteractiveCheckbox.addEventListener('change', (e) => {
            adsrInteractiveEnabled = e.target.checked;
            if (envContainer) envContainer.style.pointerEvents = adsrInteractiveEnabled ? 'auto' : 'none';
        });
    }

    // 2. Bind the envelope event listener
    adsrEnvelope.on('change', (points) => {
        if (!adsrInteractiveEnabled) return;
        if (adsrSetInProgress) return; // Prevent recursion when we call setPoints
        if (!Array.isArray(points) || points.length === 0) return;

        // Sort and pick three editable middle points (guarding against extra dots)
        const sorted = Array.from(points).sort((a, b) => a.x - b.x);
        const mid1 = sorted[1] || { x: 0.1, y: 1.0 };
        const mid2 = sorted[2] || { x: 0.3, y: 0.7 };
        const mid3 = sorted[3] || { x: 0.8, y: 0.7 };

        // Clamp and ensure ordering
        const minGap = 0.01;
        const p1x = Math.max(0.01, Math.min(mid1.x, 0.95));
        const p2x = Math.max(p1x + minGap, Math.min(mid2.x, 0.99));
        const p3x = Math.max(p2x + minGap, Math.min(mid3.x, 0.995));
        const p1y = Math.max(0, Math.min(mid1.y, 1));
        const p2y = Math.max(0, Math.min(mid2.y, 1));
        const p3y = Math.max(0, Math.min(mid3.y, 1));

        const normalized = [
            { x: 0.0, y: 0.0 },
            { x: p1x, y: p1y },
            { x: p2x, y: p2y },
            { x: p3x, y: p3y },
            { x: 1.0, y: 0.0 }
        ];

        // Normalize visual to exactly these five points
        try {
            adsrSetInProgress = true;
            adsrEnvelope.setPoints(normalized);
        } catch (err) {
            console.warn('Failed to normalize ADSR points:', err);
        }

        // Compute fractions and map to seconds using the current preset's total scale
        if (!currentPresetName || !presets[currentPresetName]) {
            setTimeout(() => { adsrSetInProgress = false; }, 0);
            return;
        }

        const currentPreset = presets[currentPresetName];
        if (!currentPreset.adsr) currentPreset.adsr = {};

        const prevAttack = currentPreset.adsr.attack_time ?? 0.1;
        const prevDecay = currentPreset.adsr.decay_time ?? 0.4;
        const prevRelease = currentPreset.adsr.release_time ?? 0.4;
        const total = prevAttack + prevDecay + ADSR_HOLD + prevRelease;

        const fracAttack = p1x; // distance from 0 to p1
        const fracDecay = p2x - p1x;
        const fracRelease = 1.0 - p3x;

        currentPreset.adsr.attack_time = Math.max(0.01, fracAttack * total);
        currentPreset.adsr.decay_time = Math.max(0.01, fracDecay * total);
        currentPreset.adsr.sustain_level = p2y;
        currentPreset.adsr.release_time = Math.max(0.01, fracRelease * total);

        outputText.textContent = `ADSR ${currentPreset.adsr.attack_time.toFixed(2)}s / ${currentPreset.adsr.decay_time.toFixed(2)}s / ${currentPreset.adsr.sustain_level.toFixed(2)} / ${currentPreset.adsr.release_time.toFixed(2)}s`;

        setTimeout(() => { adsrSetInProgress = false; }, 0);
    });

    // 3. ONLY start loading presets once all the HTML containers are safely in memory!
    loadPresets();
}

document.addEventListener('DOMContentLoaded', initUI);