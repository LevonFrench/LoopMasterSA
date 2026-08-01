---
title: "Multi-Mode Audio Filters"
type: "concept"
confidence: "high"
volatility: "warm"
tags: [audio, dsp, python, webaudio, filter]
summary: "Implementations of multi-mode audio filters available on GitHub for Python and WebAudio."
---

# Multi-Mode Audio Filters

When slotting a multi-mode audio filter into a project (like LoopMaster SA3), there are several robust open-source options available depending on the execution environment. A multi-mode filter allows dynamic switching between filtering types (Low-pass, High-pass, Band-pass, Notch) within the same architecture, making them ideal for dynamic game audio or loop manipulation.

## Python Integration (Backend / Offline)

For Python environments (where audio generation via models like Stable Audio typically occurs), the following implementations are recommended:

1. **Chamberlain State-Variable Filter (SVF)**
   - **Mechanism:** Implements the classic Chamberlain digital state-variable filter. It operates sample-by-sample, updating Low-pass, High-pass, Band-pass, and Notch outputs simultaneously.
   - **Usage:** Ideal for simple, native Python implementations without heavy C++ DSP dependencies. It calculates outputs using frequency (`f`) and resonance (`Q`) coefficients.
   - **Source:** [chamberlain-state-variable-filter](https://github.com/chamberlain-state-variable-filter/state_variable_filter.py)

2. **Sprechstimme**
   - **Mechanism:** A comprehensive Python audio synthesis library that includes professional-grade analog-style filters (including SVF).
   - **Usage:** Better if you need a full synthesis architecture alongside the filter.
   - **Source:** [Sprechstimme](https://github.com/Sprechstimme/Sprechstimme)

3. **AudioTK**
   - **Mechanism:** A C++ DSP toolbox with Python wrappers.
   - **Usage:** Best for high-performance, production-grade offline or real-time filtering where native Python loops would be too slow.
   - **Source:** [AudioTK](https://github.com/AudioTK/AudioTK)

## WebAudio Integration (Frontend / Real-time)

If the filtering is to be applied on the client-side (e.g., inside the Vue frontend for LoopMaster), native browser APIs are highly optimized:

1. **Native BiquadFilterNode**
   - **Mechanism:** The Web Audio API provides the `BiquadFilterNode` natively, which acts as a multi-mode filter supporting `lowpass`, `highpass`, `bandpass`, `lowshelf`, `highshelf`, `peaking`, `notch`, and `allpass`.
   - **Usage:** Zero dependencies, runs highly optimized in the browser. Recommended for most web implementations.

2. **Modular Web Synthesizers (Reference Implementations)**
   - **michael-graute/modular-web-synthesizer**: Provides modular Web Audio abstractions.
   - **grz0zrg/fas**: Provides complex subtractive synthesis examples utilizing WebAudio filters.

## Recommendations for LoopMaster SA3

- **If filtering is applied post-generation on the server:** Use a native Python SVF implementation (like the Chamberlain script) for easy integration, or wrap a C++ library like AudioTK if performance is a bottleneck on long audio loops.
- **If filtering is applied interactively by the user:** Use the native Web Audio `BiquadFilterNode` in the browser. It natively supports multi-mode switching and handles audio context synchronization perfectly, avoiding server round-trips.

## References
* [[2026-06-29-python-state-variable-filters|GitHub Multi-Mode Audio Filters (Python & WebAudio)]](../../raw/articles/2026-06-29-python-state-variable-filters.md)
