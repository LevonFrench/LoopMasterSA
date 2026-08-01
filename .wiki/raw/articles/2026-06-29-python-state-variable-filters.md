---
title: "GitHub Multi-Mode Audio Filters (Python & WebAudio)"
source: "GitHub Search"
type: "article"
tags: [audio, dsp, python, webaudio, filter]
summary: "A review of available multi-mode filter implementations for Python and WebAudio."
---

# GitHub Multi-Mode Audio Filters

## Python Implementations

### Chamberlain State-Variable Filter (SVF)
A standard digital state-variable filter is popular in audio synthesis because it is stable and allows for independent control of cutoff frequency and resonance (Q).

In a typical Python implementation, the core `update` method performs the following calculations per sample:
1. **High-pass (HP)** = Input - Low-pass - (Q * Band-pass)
2. **Band-pass (BP)** = BP + (f * HP)
3. **Low-pass (LP)** = LP + (f * BP)
4. **Notch (NP)** = LP + HP

*(Where `f` is the frequency coefficient derived from the sample rate and desired cutoff frequency, and `Q` determines the resonance.)*

### Sprechstimme
A comprehensive Python library for audio synthesis that includes professional-grade, analog-style filters such as the state-variable filter, along with other advanced synthesis features.
[GitHub - Sprechstimme/Sprechstimme](https://github.com/Sprechstimme/Sprechstimme)

### AudioTK
A powerful DSP toolbox that includes various filter implementations and Python wrappers, useful if you are looking for a more robust or production-oriented framework.
[GitHub - AudioTK/AudioTK](https://github.com/AudioTK/AudioTK)

## WebAudio / JavaScript Implementations

### Web Audio API BiquadFilterNode
For direct implementations within the Web Audio API, developers often use the native `BiquadFilterNode`, which supports multiple types (`lowpass`, `highpass`, `bandpass`, `lowshelf`, `highshelf`, `peaking`, `notch`, `allpass`), effectively acting as a multi-mode filter.

### Modular Web Synthesizer
**michael-graute/modular-web-synthesizer**: This project explicitly lists a "Multi-mode filter (lowpass, highpass ...)" as part of its features for a modular Web Audio API-based synthesizer.

### FAS
**grz0zrg/fas**: This is a graphical audio synthesizer that features a multi-mode filter per voice for subtractive synthesis.
