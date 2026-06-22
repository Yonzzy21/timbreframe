import os
import json
import numpy as np
import librosa
from scipy.signal import find_peaks

# =====================================================================
# 1. CENTRAL CONFIGURATION CONTROL PANEL (The Dashboard)
# =====================================================================
# To change the configuration, simply modify the values in this dictionary.
INSTRUMENT_ID = "bass_clarinet"
INSTRUMENT_NAME = "Bass Clarinet"
INPUT_AUDIO_FILE = "./assets/chopped_clarinet.wav"

CONFIG = {
    "sr": 44100,
    "duration": 5.0,
    "vibrato_freq": 4.0,
    "vibrato_mag": 0.03,
    "vibrato_attack_time": 2.0,
    "am_freq": 5.0,
    "am_depth": 0.065,
    "attack_time": 0.1,
    "decay_time": 0.6,
    "sustain_level": 0.8,
    "release_time": 0.3
}

###Helper functions for the specific instrument

def create_vibrato_envelope(duration, sr,vibrato_attack_time):
    t = np.arange(0, duration, 1/sr)
    total_samples = len(t)
    attack_samples = int(vibrato_attack_time * sr)
    sustain_samples = total_samples - attack_samples
    # Fade in from 0.0 (no vibrato) to 1.0 (full vibrato)
    vib_attack = np.linspace(0.0, 1.0, attack_samples)
    vib_sustain = np.ones(sustain_samples)
    vib_envelope = np.concatenate([vib_attack, vib_sustain])
    return vib_envelope

def create_adsr_envelope(duration, sr, attack_time=0.5, decay_time=0.3, release_time=0.5, sustain_level=0.7):
    t = np.arange(0, duration, 1/sr)
    total_samples = len(t)
    # Convert times to sample counts
    attack_samples = int(attack_time * sr)
    decay_samples = int(decay_time * sr)
    release_samples = int(release_time * sr)
    sustain_samples = total_samples - (attack_samples + decay_samples + release_samples)
    
    # 1. Attack: Linear ramp from 0.0 to 1.0
    attack = np.linspace(0.0, 1.0, attack_samples)
    
    # 2. Decay: Linear ramp from 1.0 down to sustain level
    decay = np.linspace(1.0, sustain_level, decay_samples)
    
    # 3. Sustain: Constant level
    sustain = np.ones(sustain_samples) * sustain_level
    
    # 4. Release: Linear ramp from sustain level down to 0.0
    release = np.linspace(sustain_level, 0.0, release_samples)
    
    # Concatenate all stages together into one continuous envelope
    envelope = np.concatenate([attack, decay, sustain, release])
    
    # If there's a minor rounding error in sample length, pad or trim to match 't' exactly
    if len(envelope) < total_samples:
        envelope = np.pad(envelope, (0, total_samples - len(envelope)), 'constant')
    elif len(envelope) > total_samples:
        envelope = envelope[:total_samples]
        
    return envelope

def analyze_and_extract_peaks(file_path, sr, n_fft=4096, hop_length=1024):
    x, _ = librosa.load(file_path, sr=sr)
    freq_res = sr / n_fft
    time = len(x)/sr #time in seconds
    X = librosa.stft(x, n_fft=n_fft, hop_length=hop_length)
    mag = np.abs(X)
    X_db = librosa.amplitude_to_db(mag, ref=np.max)

    mag_mean = np.mean(mag, axis=1) ####Taking the mean of the magnitude across the time axis
    print(mag_mean.shape)
    peaks, _ = find_peaks(mag_mean, distance=10, prominence=np.max(mag_mean)*0.006) ####frequency bins
    if peaks.shape[0] > 24: ###maintains 24 peaks
        peaks = peaks[:24] 


    peak_to_hz = peaks *freq_res #converting peak indices to frequencies
    freq_mag_mean= mag_mean[peaks] ####Getting the mean magnitude at the peak frequencies
    return peak_to_hz, freq_mag_mean

def export_instrument_preset(instrument_id, instrument_name, peak_to_hz, freq_mag_mean, config, json_path="presets.json"):
    """
    Analyzes the peaks/magnitudes using custom config parameters,
    extracts the normalized relative magnitudes, and saves/appends to a JSON file.
    """
    # 1. Pull settings from the config dictionary
    sr = config.get("sr", 44100)
    duration = config.get("duration", 8.0)
    
    vib_freq = config.get("vibrato_freq", 4.0)
    vib_mag = config.get("vibrato_mag", 0.11)
    vib_attack = config.get("vibrato_attack_time", 2.0)
    
    am_freq = config.get("am_freq", 5.0)
    am_depth = config.get("am_depth", 0.065)
    
    attack = config.get("attack_time", 1.0)
    decay = config.get("decay_time", 0.6)
    sustain = config.get("sustain_level", 0.7)
    release = config.get("release_time", 0.5)

    # 2. Re-create the temporary synthesis timeline to find the TRUE global max
    # (We must simulate the synthesis to know how the envelopes/modulations affect the peaks)
    t = np.arange(0, duration, 1/sr)
    multichannel_audio = np.zeros((len(peak_to_hz), len(t)))
    fund_freq = peak_to_hz[0]
    
    # Re-create envelopes based on inputs
    vib_envelope = create_vibrato_envelope(duration=duration, sr=sr, vibrato_attack_time=vib_attack)
    mag_envelope = create_adsr_envelope(duration, sr, attack_time=attack, decay_time=decay, release_time=release, sustain_level=sustain)

    for i in range(len(peak_to_hz)):
        freqs = peak_to_hz[i]
        magnitude = freq_mag_mean[i]
        harm_rank = freqs / fund_freq

        random_phase_offset = np.random.rand() * 2 * np.pi
        scaled_am_freq = am_freq + (0.1 * harm_rank)

        mag_modulation = am_depth * np.sin(2 * np.pi * scaled_am_freq * t + random_phase_offset)
        subtle_mag_mod = magnitude * (1 + mag_modulation)
        scaled_vib_magnitude = vib_mag * harm_rank * vib_envelope

        channel_wave = subtle_mag_mod * np.sin(2 * np.pi * freqs * t + scaled_vib_magnitude * np.sin(2 * np.pi * vib_freq * t))
        multichannel_audio[i, :] = channel_wave * mag_envelope

    # 3. System-Wide Multichannel Normalization
    global_max = np.max(np.abs(multichannel_audio))
    
    # Calculate the exact scalar used to bring the highest peak to exactly 0.5
    # Any channel's base magnitude * this scaling factor = its true relative peak!
    normalization_factor = 0.5 / global_max if global_max > 0 else 1.0
    
    # Extract the true, safely scaled peak amplitudes for the JSON
    final_normalized_magnitudes = []
    for i in range(len(peak_to_hz)):
        channel_peak = np.max(np.abs(multichannel_audio[i, :])) * normalization_factor
        final_normalized_magnitudes.append(float(channel_peak))

    # 4. Construct the ultra-customizable Preset Data Object
    preset_entry = {
        "name": instrument_name,
        "audio_settings": {
            "sr": int(sr),
            "duration": float(duration)
        },
        "adsr": {
            "attack_time": float(attack),
            "decay_time": float(decay),
            "sustain_level": float(sustain),
            "release_time": float(release)
        },
        "vibrato": {
            "frequency": float(vib_freq),
            "magnitude": float(vib_mag),
            "attack_time": float(vib_attack)
        },
        "amplitude_modulation": {
            "frequency": float(am_freq),
            "depth": float(am_depth)
        },
        # NumPy arrays converted to clean standard Python lists
        "frequencies": [float(f) for f in peak_to_hz],
        "magnitudes": final_normalized_magnitudes
    }

    # 5. Read existing presets or initialize a new library dictionary
    if os.path.exists(json_path):
        try:
            with open(json_path, "r") as f:
                database = json.load(f)
        except json.JSONDecodeError:
            database = {}
    else:
        database = {}

    # 6. Append/Overwrite this specific instrument entry
    database[instrument_id] = preset_entry

    # 7. Write cleanly indented back to disk
    with open(json_path, "w") as f:
        json.dump(database, f, indent=4)

    print(f"🎉 Success! '{instrument_name}' [ID: {instrument_id}] saved to {json_path}")

if __name__ == "__main__":
    print(f"Starting decomposition for: {INSTRUMENT_NAME}...")
    
    # Run the processing steps using your control panel variables
    peaks, magnitudes = analyze_and_extract_peaks(INPUT_AUDIO_FILE, CONFIG["sr"])
    
    export_instrument_preset(
        instrument_id=INSTRUMENT_ID,
        instrument_name=INSTRUMENT_NAME,
        peak_to_hz=peaks,
        freq_mag_mean=magnitudes,
        config=CONFIG
    )