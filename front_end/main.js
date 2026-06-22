// The number of outputs we ask the browser to merge into one multichannel stream.
// Keep this at 24 for the real installation, but allow a stereo preview mode for testing.
const NUM_OUTPUTS = 24;
const PRESET_URL = '../presets.json';

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
let audioContext = null; // Single AudioContext for the page.
let currentPresetName = null; // The selected preset key.
let currentDuration = 8.0; // Duration in seconds for playback.
let stereoPreviewEnabled = false; // Toggle stereo preview while keeping the default multichannel graph.
let channels = []; // Array of channel objects for each sine partial.
let channelSettings = []; // Current slider settings, used before and during playback.
let mergerNode = null; // The 24-input ChannelMergerNode.
let masterGain = null; // The final gain before audio output.
let stopTimeoutId = null; // Timeout used to clean up after the preset duration.

// Load presets.json and fill the preset selector.
async function loadPresets() {
    try {
        const response = await fetch(PRESET_URL); // Fetch the JSON file.
        if (!response.ok) {
            throw new Error(`Could not load presets: ${response.status}`);
        }

        presets = await response.json(); // Parse the JSON.
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
            if (currentPresetName) {
                updatePresetUI(presets[currentPresetName]); // Reload preset defaults without changing selection.
            }
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

        const row = document.createElement('div');
        row.className = 'slider-row';

        const label = document.createElement('label');
        label.textContent = `Channel ${index + 1}: ${frequency.toFixed(1)} Hz`;
        label.htmlFor = `freq-slider-${index}`;

        const frequencyLabel = document.createElement('div');
        frequencyLabel.textContent = 'Frequency';
        frequencyLabel.className = 'slider-label';

        const frequencyValue = document.createElement('span');
        frequencyValue.className = 'slider-value';
        frequencyValue.textContent = frequency.toFixed(1);

        const freqSlider = document.createElement('input');
        freqSlider.type = 'range';
        freqSlider.id = `freq-slider-${index}`;
        freqSlider.min = String(frequency * 0.75); // allow tuning downward by 25%
        freqSlider.max = String(frequency * 1.25); // allow tuning upward by 25%
        freqSlider.step = String(Math.max(0.1, frequency * 0.001));
        freqSlider.value = String(frequency);

        freqSlider.addEventListener('input', () => {
            const newFrequency = Number(freqSlider.value);
            frequencyValue.textContent = newFrequency.toFixed(1);
            channelSettings[index].desiredFrequency = newFrequency;

            if (channels[index] && channels[index].osc) {
                channels[index].osc.frequency.value = newFrequency;
            }
        });

        const magnitudeLabel = document.createElement('div');
        magnitudeLabel.textContent = 'Magnitude';
        magnitudeLabel.className = 'slider-label';

        const magnitudeValue = document.createElement('span');
        magnitudeValue.className = 'slider-value';
        magnitudeValue.textContent = magnitude.toFixed(3);

        const magSlider = document.createElement('input');
        magSlider.type = 'range';
        magSlider.id = `mag-slider-${index}`;
        magSlider.min = '0';
        magSlider.max = '1';
        magSlider.step = '0.001';
        magSlider.value = String(magnitude);

        magSlider.addEventListener('input', () => {
            const newMagnitude = Number(magSlider.value);
            magnitudeValue.textContent = newMagnitude.toFixed(3);
            channelSettings[index].desiredMagnitude = newMagnitude;

            if (channels[index] && channels[index].sliderGain) {
                const gainParam = channels[index].sliderGain.gain;
                const now = audioContext?.currentTime || 0;
                gainParam.cancelScheduledValues(now);
                gainParam.setValueAtTime(gainParam.value, now);
                gainParam.linearRampToValueAtTime(newMagnitude, now + 0.02);
            }
        });

        row.appendChild(label);
        row.appendChild(frequencyLabel);
        row.appendChild(freqSlider);
        row.appendChild(frequencyValue);
        row.appendChild(magnitudeLabel);
        row.appendChild(magSlider);
        row.appendChild(magnitudeValue);
        slidersContainer.appendChild(row);
    });

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

    const adsr = {
        attack_time: Math.max(preset.adsr?.attack_time ?? 0.01, 0.01),
        decay_time: preset.adsr?.decay_time ?? 0.6,
        sustain_level: preset.adsr?.sustain_level ?? 0.7,
        release_time: Math.max(preset.adsr?.release_time ?? 0.01, 0.01),
    };

    const vibrato = {
        frequency: preset.vibrato?.frequency ?? 4.0,
        magnitude: preset.vibrato?.magnitude ?? 0.11,
        attack_time: preset.vibrato?.attack_time ?? 2.0,
    };

    const amplitudeMod = {
        frequency: preset.amplitude_modulation?.frequency ?? 5.0,
        depth: preset.amplitude_modulation?.depth ?? 0.065,
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

loadPresets(); // Begin by loading presets from JSON.
