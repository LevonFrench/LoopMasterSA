---
confidence: high
volatility: cold
---

# Generation Pipeline

This article explains the prompt processing, model configurations, and backend generation pipeline in LoopMaster SA3.

## Model Configurations

Stable Audio 3 utilizes a diffusion transformer (DiT) structure to synthesize high-quality stereo audio from conditioning signals (text prompts, BPM, and length). LoopMaster SA3 supports multiple model weights:
- **Medium Model (Official)**: 1.0B parameters, FP32 precision. Runs natively on CUDA.
- **Medium Model (Optimized - BF16)**: Low VRAM footprint utilizing Bfloat16 precision weights (`dummy9996/stable-audio-3-bf16-comfyui`), which decreases memory usage without affecting audio quality.
- **Small Music Model**: Lightweight model optimized for faster generation cycles (GPU or CPU).
- **Small SFX Model**: Specialized checkpoint for generating one-shot sound effects and ambient textures.

## Backend Code Structure

The backend generation logic is strictly modularized for clarity and maintainability:
1. **Unified Execution Handler**: The core logic is driven by a single robust `_execute_model_task` function in the Flask server. It dynamically parses `unlocked_indices` to route both full tracking generations and partial regenerations through the exact same PyTorch sampling, zero-padding, crossfading, and metadata processing pipeline.
2. **Modular WAV Processing**: All prompt enhancement (grammar normalisation, keyword injection) and metadata extraction logic (ACID chunk building, root note parsing) resides in a dedicated `wav_metadata.py` module to isolate logic from server routing.

## Prompt Engineering & Enhancement

To align user text with the training data of Stable Audio 3 (AudioSparx and Freesound), the backend (`wav_metadata.py`) processes prompts through an enhancement pipeline:

1. **Tempo Parameter Stripping**:
   All user-written tempo indicators matching `re.sub(r'\b(?:at\s+)?\d+\s*bpm\b', '', prompt, flags=re.IGNORECASE)` are removed from the input prompt to prevent semantic conflicts.
2. **Grammar Normalisation**:
   Double commas, trailing conjunctions (like an orphaned "at"), and excess spacing around commas are cleaned.
3. **Structured Metadata Injection**:
   The server appends standardized metadata tags for BPM and duration: `, BPM: {bpm}. Length: {duration}.` directly to the prompt.
4. **Keyword Augmentation**:
   Unless the prompt is classified as SFX, the backend prepends `solo` and appends `seamless loop, clean recording, high quality` to improve fidelity.

## Drum Fill Steering

For drum-related prompts, a specialized variant-specific list-conditioning pipeline is triggered:
- **Detection**: A regex word-boundary filter checks the prompt for drum terminology (`drums`, `perc`, `beat`, etc.).
- **Steering**: If a drum track is detected, the 4th variant generated (index 3) is given an altered prompt list element. It swaps `seamless loop` with `drum fill, drum roll`, and sets `loop=False` in the WAV metadata. This produces a drum transition one-shot.

## Inpainting and crossfading

For remixing modes (Inpainting, Continuation, Call & Response), the seed waveform is padded to align with target generation bounds.
- **Crossfade Blending**: Boundary overlap ranges (0.3s) are blended in the backend via a PyTorch-based linear crossfade to ensure click-free transitions between original seed audio and newly generated latents.

## VAE Decoding Stages

Decentralized autoencoder (VAE) decoding converts latents back into audio waveforms. The server tracks progress and sends explicit state updates:
- `vae_start`: Triggered before latents are passed to the autoencoder. The frontend updates the status bar to show `Decoding audio latents using VAE (30-40s)...`.
- `vae_end`: Signal indicating decoding completion and WAV output saving.

## ACIDization

Every generated loop has ACID chunk tags inserted into the WAV file header:
- Tempo (BPM) value.
- Time signature (default 4/4).
- Number of beats (calculated from tempo and duration).
- Loop/One-Shot tag (the 4th variant of drum tracks is marked as a one-shot).

## Related Documents
- `[[concepts/architecture|System Architecture]]` ([System Architecture](architecture.md))
- `[[topics/remixing|Remixing & Outpainting]]` ([Remixing & Outpainting](../topics/remixing.md))
- `[[references/api_reference|API Reference]]` ([API Reference](../references/api_reference.md))
