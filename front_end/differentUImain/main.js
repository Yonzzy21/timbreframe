// The number of outputs we ask the browser to merge into one multichannel stream.
// Keep this at 24 for the real installation, but allow a stereo preview mode for testing.
const NUM_OUTPUTS = 24;
const PRESET_URL = 'presets.json';
// Default hold time used by ADSR envelope UI mapping (seconds)
const ADSR_HOLD = 0.1;

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
let visualAnalyser = null; // AnalyserNode used for the visualizer
let visualizerAnimationId = null;
let visualizerSettings = {
    barColor: '#d76315',
    bgColor: 'rgba(18,28,44,0.95)',
    scale: 'dB', // 'dB' or 'linear'
    freqScale: 'log' // 'linear' or 'log' frequency axis
};
// Whether to visualize power magnitude (true => square of amplitude)
visualizerSettings.power = true;
// Spectrogram options
visualizerSettings.perBin = true; // map one analyser bin -> one vertical pixel row
visualizerSettings.halfSum = 1;   // aggregate ±halfSum FFT bins when computing energy
let specAnimId = null; // Animation frame id for spectrogram

function stopSpectrogram() {
    // Stop the spectrogram animation if running
    if (specAnimId) {
        cancelAnimationFrame(specAnimId);
        specAnimId = null;
    }
}

// Start a simple canvas-based spectrogram using the existing `visualAnalyser`.
function startSpectrogram() {
    const canvas = document.getElementById('spectrumCanvas');
    if (!canvas || !visualAnalyser || !audioContext) return;
    const ctx = canvas.getContext('2d');
    const binCount = visualAnalyser.frequencyBinCount;
    const floatData = new Float32Array(binCount);

    // Size canvas to CSS pixels if not already sized
    canvas.width = Math.max(200, canvas.clientWidth || 300);
    canvas.height = Math.max(128, canvas.clientHeight || 128);
    const w = canvas.width;
    const h = canvas.height;

    if (specAnimId) cancelAnimationFrame(specAnimId);
    const sampleRate = (audioContext && audioContext.sampleRate) || 44100;
    const nyquist = sampleRate / 2;
    const minFreq = 20;
    const max_freq = 8000
    const logmin = Math.log10(minFreq);
    const logmax = Math.log10(max_freq);

    function draw() {
        visualAnalyser.getFloatFrequencyData(floatData);

        // Scroll left one pixel
        ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
        ctx.clearRect(w - 1, 0, 1, h);

        const minDb = visualAnalyser.minDecibels ?? -120;
        const maxDb = visualAnalyser.maxDecibels ?? -10;

        // Draw bins as 1px rows (high freq at top)
        for (let y = 0; y < h; y++) {
            const percent = 1 - (y / (h - 1));
            const logfreq = logmin + percent * (logmax - logmin);
            const freq = Math.pow(10, logfreq);
            const linear_bin = Math.round(freq/nyquist * (binCount - 1));
            const clampedBin = Math.max(0, Math.min(binCount - 1, linear_bin));

            const db = floatData[clampedBin];
            let norm = (db - minDb) / (maxDb - minDb);
            norm = Math.max(0, Math.min(1, norm));
            ctx.fillStyle = ampToColor(norm);
            ctx.fillRect(w - 1, y, 1, 1);
        }

        specAnimId = requestAnimationFrame(draw);
    }

    specAnimId = requestAnimationFrame(draw);
}

function ampToColor(norm) {
    const n = Math.max(0, Math.min(1, Number(norm) || 0));
    const hue = 220 - Math.round(n * 220); // blue -> red
    const light = Math.max(10, Math.round(25 + n * 50));
    return `hsl(${hue} ${90}% ${light}%)`;
}

function startVisualizer() {
    const canvas = document.getElementById('spectrumCanvas');
    if (!canvas || !visualAnalyser) return;
    const ctx = canvas.getContext('2d');
    const sampleRate = (audioContext && audioContext.sampleRate) ? audioContext.sampleRate : 44100;
    const binCount = visualAnalyser.frequencyBinCount;

    const draw = () => {
        const data = new Uint8Array(binCount);
        visualAnalyser.getByteFrequencyData(data);

        // determine frequencies to show: use channelSettings desiredFrequency if available
        const freqs = channelSettings.length ? channelSettings.map(c => c.desiredFrequency) : (presets[currentPresetName]?.frequencies || []);
        const N = Math.max(1, Math.min(freqs.length || NUM_OUTPUTS, freqs.length || NUM_OUTPUTS));

        ctx.fillStyle = visualizerSettings.bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const barWidth = canvas.width / N;
        for (let i = 0; i < N; i++) {
            const freq = freqs[i] || 0;
            const bin = freqToBin(freq, sampleRate, binCount);
            const v = data[bin]; // 0-255

            let norm = v / 255;
            if (visualizerSettings.scale === 'dB') {
                const minDb = visualAnalyser.minDecibels ?? -40;
                const maxDb = visualAnalyser.maxDecibels ?? -15;
                const db = (v / 255) * (maxDb - minDb) + minDb;
                norm = (db - minDb) / (maxDb - minDb);
            }

            const barHeight = Math.max(2, Math.floor(norm * canvas.height));
            const x = i * barWidth;
            const y = canvas.height - barHeight;
            ctx.fillStyle = visualizerSettings.barColor;
            ctx.fillRect(x + 1, y, Math.floor(barWidth) - 2, barHeight);
        }

        visualizerAnimationId = requestAnimationFrame(draw);
    };

    if (visualizerAnimationId) cancelAnimationFrame(visualizerAnimationId);
    visualizerAnimationId = requestAnimationFrame(draw);
}

function stopVisualizer() {
    if (visualizerAnimationId) {
        cancelAnimationFrame(visualizerAnimationId);
        visualizerAnimationId = null;
    }
}

// Create UI controls for the visualizer and wire up event handlers.
function createVisualizerUI() {
    const vizBarColor = document.getElementById('vizBarColor');
    const vizBgColor = document.getElementById('vizBgColor');
    const vizScale = document.getElementById('vizScale');
    const canvas = document.getElementById('spectrumCanvas');

    if (vizBarColor) {
        vizBarColor.value = visualizerSettings.barColor || '#d76315';
        vizBarColor.addEventListener('input', (e) => { visualizerSettings.barColor = e.target.value; });
    }
    if (vizBgColor) {
        vizBgColor.value = visualizerSettings.bgColor || '#121c2c';
        vizBgColor.addEventListener('input', (e) => { visualizerSettings.bgColor = e.target.value; if (canvas) canvas.style.background = e.target.value; });
        if (canvas) canvas.style.background = visualizerSettings.bgColor;
    }
    if (vizScale) {
        vizScale.value = visualizerSettings.scale || 'dB';
        vizScale.addEventListener('change', (e) => { visualizerSettings.scale = e.target.value; });
    }

    // Disable start until presets are loaded and a preset is selected.
    if (startButton) startButton.disabled = true;
}

    // Add per-bin/hafSum controls to visualizer-controls container
    const vizControls = document.getElementById('visualizer-controls');
    if (vizControls && !document.getElementById('vizPerBin')) {
        const perBinLabel = document.createElement('label');
        perBinLabel.style.display = 'inline-flex';
        perBinLabel.style.alignItems = 'center';
        perBinLabel.style.gap = '8px';
        perBinLabel.innerHTML = 'Per-bin <input id="vizPerBin" type="checkbox">';
        vizControls.appendChild(perBinLabel);

        const halfSumLabel = document.createElement('label');
        halfSumLabel.style.display = 'inline-flex';
        halfSumLabel.style.alignItems = 'center';
        halfSumLabel.style.gap = '8px';
        halfSumLabel.innerHTML = 'HalfSum <input id="vizHalfSum" type="range" min="0" max="8" step="1" value="' + (visualizerSettings.halfSum || 1) + '">';
        vizControls.appendChild(halfSumLabel);

        const perBinCheckbox = document.getElementById('vizPerBin');
        const halfSumRange = document.getElementById('vizHalfSum');
        if (perBinCheckbox) {
            perBinCheckbox.checked = !!visualizerSettings.perBin;
            perBinCheckbox.addEventListener('change', (e) => { visualizerSettings.perBin = e.target.checked; });
        }
        if (halfSumRange) {
            halfSumRange.addEventListener('input', (e) => { visualizerSettings.halfSum = Number(e.target.value); });
        }
    }

 

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
async function loadPresets() {
    try {
        const response = await fetch(PRESET_URL);
        if (!response.ok) throw new Error(`Could not load presets: ${response.status}`);
        presets = await response.json();
        originalPresets = JSON.parse(JSON.stringify(presets));
        const presetNames = Object.keys(presets);
        if (!presetNames.length) throw new Error('No presets found in presets.json');

        presetNames.forEach((key) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = presets[key].name || key;
            presetSelect.appendChild(option);
        });

        currentPresetName = presetNames[0];
        presetSelect.value = currentPresetName;

        presetSelect.addEventListener('change', () => {
            currentPresetName = presetSelect.value;
            updatePresetUI(presets[currentPresetName]);
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
            if (originalPresets && originalPresets[currentPresetName]) {
                presets[currentPresetName] = JSON.parse(JSON.stringify(originalPresets[currentPresetName]));
            }
            updatePresetUI(presets[currentPresetName]);
        });

        updatePresetUI(presets[currentPresetName]);
        infoText.textContent = `Loaded ${presetNames.length} presets from presets.json.`;
        // Enable Start button now that presets are loaded and a preset is selected
        if (startButton) startButton.disabled = false;
    } catch (error) {
        infoText.textContent = `Error loading presets: ${error.message}`;
        console.error(error);
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
        size: [600, 400],         // [Width, Height] - Make it wide and tall!
        numberOfSliders: frequencies.length, // Automatically scales to match your preset (e.g., 24)
        min: -60,
        max: 0,
        step: 0.001,
        values: dbValues       // Automatically sets the starting bars to your preset volumes!
    });

    magMultislider.colorize("accent", "#d76315");

    // Treat very low dB values as exact silence to avoid audible remnants.
    const SILENCE_THRESHOLD = 1e-6; // linear amplitude below this is treated as 0
    const SILENCE_DB_THRESHOLD = -59.99; // dB values at or below this are treated as silence
    magMultislider.on('change', (matrixValues) => {
    // Since 'matrixValues' may be an array of numbers or arrays, normalize defensively
    console.log('Multislider change:', matrixValues);
    matrixValues.forEach((newDb, channelIndex) => {
        // Normalize possible nested array values
        let dbVal = newDb;
        if (Array.isArray(dbVal)) dbVal = dbVal[0];
        dbVal = Number(dbVal);
        if (!Number.isFinite(dbVal)) dbVal = -60;

        // If the dB reading is effectively the minimum, treat it as exact silence.
        let linearMagnitude = 0;
        if (dbVal > SILENCE_DB_THRESHOLD) {
            linearMagnitude = dbToLinear(dbVal);
            if (linearMagnitude < SILENCE_THRESHOLD) linearMagnitude = 0;
        }

        if (channelSettings[channelIndex]) {
            channelSettings[channelIndex].desiredMagnitude = linearMagnitude;
        }

        // Adjust the live audio gain node immediately to avoid residual leakage
        if (channels[channelIndex] && channels[channelIndex].sliderGain) {
            const gainParam = channels[channelIndex].sliderGain.gain;
            const now = audioContext?.currentTime || 0;
            gainParam.cancelScheduledValues(now);
            gainParam.setValueAtTime(linearMagnitude, now);
            gainParam.linearRampToValueAtTime(linearMagnitude, now + 0.02);
            console.log('Applied gain -> channel', channelIndex, 'db', dbVal, 'linear', linearMagnitude);
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

    // spectrogram renderer removed — nothing to stop

    channels = []; // Reset channel array.
    startButton.disabled = false; // Allow start again.
    stopButton.disabled = true; // Disable stop until next play.

    // Stop visualizer and spectrogram
    try { stopVisualizer(); } catch (err) { }
    try { stopSpectrogram(); } catch (err) { }
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
    console.log('createAudioGraph: sampleRate=', context.sampleRate, 'stereoPreview=', stereoPreviewEnabled);
    const duration = currentDuration;
    const livePresetData = presets[currentPresetName] || preset;
    const adsr = {
        attack_time: Math.max(livePresetData.adsr?.attack_time ?? 0.01, 0.01),
        decay_time: livePresetData.adsr?.decay_time ?? 0.6,
        sustain_level: livePresetData.adsr?.sustain_level ?? 0.7,
        release_time: Math.max(livePresetData.adsr?.release_time ?? 0.01, 0.01),
        attack_per_partial: livePresetData.adsr?.attack_per_partial ?? 0.003 // 👈 ADD THIS LINE
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

    // Create/create-or-reuse an analyser for visualizations
    try {
        visualAnalyser = context.createAnalyser();
        visualAnalyser.fftSize = 4096;
        // Use a wider dB range so quiet and loud partials are both visible
        visualAnalyser.minDecibels = -120;
        visualAnalyser.maxDecibels = -10;
        // Connect masterGain to analyser so it sees the final mix
        masterGain.connect(visualAnalyser);
    } catch (err) {
        console.warn('Failed to create visual analyser:', err);
        visualAnalyser = null;
    }


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
        const harm_rank = frequency / frequencies[0];
        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = desiredFrequency; // Use the current slider frequency.

        const sliderGain = context.createGain();
        // Ensure no previously scheduled ramps remain and set the initial gain explicitly
        try {
            sliderGain.gain.cancelScheduledValues(context.currentTime);
            sliderGain.gain.setValueAtTime(desiredMagnitude, context.currentTime);
        } catch (err) {
            sliderGain.gain.value = desiredMagnitude;
        }
        console.log('createAudioGraph: channel', index, 'desiredMagnitude', desiredMagnitude);

        const amGain = context.createGain();
        amGain.gain.setValueAtTime(1.0, startTime); // Base amplitude modulation envelope.

        const amOsc = context.createOscillator();
        amOsc.type = 'sine';
        amOsc.frequency.value = amplitudeMod.frequency;

        const amOscGain = context.createGain();
        amOscGain.gain.value = amplitudeMod.depth;
        amOsc.connect(amOscGain).connect(amGain.gain); // AM oscillator modulates the gain.
        
        const channelAttackDuration = adsr.attack_time +adsr.attack_per_partial * (harm_rank - 1);
        const channelAttackEnd = startTime + channelAttackDuration;
        const channelDecayEnd = channelAttackEnd + adsr.decay_time;
        const channelSustainLevel = Math.max(adsr.sustain_level * Math.exp(-0.25 * (harm_rank - 1)), 0.1);
        const channelReleaseStart = Math.max(endTime - adsr.release_time, channelDecayEnd);

        const envGain = context.createGain();
        console.log({
            startTime,
            channelAttackEnd,
            channelDecayEnd,
            channelSustainLevel
        });

        envGain.gain.setValueAtTime(0.0, startTime); // Start silent.
        envGain.gain.linearRampToValueAtTime(1.0, channelAttackEnd); // Attack up.
        envGain.gain.linearRampToValueAtTime(channelSustainLevel, channelDecayEnd); // Decay to sustain.
        envGain.gain.setValueAtTime(channelSustainLevel, channelReleaseStart); // Hold sustain.
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

    // Nexus spectrogram disabled — no analyser connection required here



    stopTimeoutId = setTimeout(() => {
        cleanupAudioGraph();
        outputText.textContent = 'Audio finished.';
    }, (duration + 0.1) * 1000);
}

// Start audio playback for the current preset.
function startAudio() {
    console.log('startAudio: preset=', currentPresetName, 'audioContextState=', audioContext?.state);
    if (!currentPresetName) {
        return; // Nothing selected.
    }

    const preset = presets[currentPresetName];
    if (!preset) {
        infoText.textContent = 'Preset not found.';
        return;
    }

    const context = getAudioContext(preset.audio_settings?.sr || 44100);

    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume(); // Resume if the context was paused.
    }

    // spectrogram disabled: remove placeholder content if present
    const _targetEl = document.getElementById('target');
    if (_targetEl) _targetEl.innerHTML = '';

    cleanupAudioGraph(); // Remove any previous audio graph.
    createAudioGraph(preset); // Build a fresh graph.

    // Start spectrogram visualization if available
    if (typeof startSpectrogram === 'function') {
        try { startSpectrogram(); } catch (err) { console.warn('Failed to start spectrogram:', err); }
    } else {
        console.warn('startSpectrogram not available.');
    }

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
        bg: 'rgba(254, 10, 10, 0.2)', // 💡 ADD THIS: Makes the canvas background dark/semi-transparent!
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
    createVisualizerUI();
    loadPresets();
}

document.addEventListener('DOMContentLoaded', initUI);