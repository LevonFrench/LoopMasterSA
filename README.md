# LoopMaster SA3

A browser-based loop production studio powered by Stable Audio 3. Generate synchronized multi-track loops from text prompts, shape them with hardware-modeled FX, and export DAW-ready stems — all from one page.

---

## What It Does

- **Text-to-Loop Generation** — Type a prompt, get four stereo loop variants at 44.1kHz. Drums, bass, leads, anything SA3 can produce.
- **Synchronized Grid** — Every track plays in lockstep. Add layers, audition variants, build arrangements in real time.
- **Channel Strip FX** — Each track gets a full effects chain: Luftikus EQ, Valentine saturation/compression, Ælapse tape delay & spring reverb, Scream distortion, and Filtr resonant filter. All hardware-modeled in Web Audio.
- **Remix Engine** — Use any variant as a seed for Variation, Inpainting, Continuation, or Call & Response regeneration.
- **Macro Controls** — One-knob sweeps for Space, Drive, Tone, Filter, and Crush. Musical results without tweaking individual parameters.
- **Master Limiter** — Brickwall limiter with makeup gain on the master bus. Loud and clean without clipping.
- **DAW Export** — Render the full mix to WAV (with FX and fade-out tail), or batch-export individual stems as a ZIP. All WAVs are ACIDized with tempo/key/beat markers for instant DAW import.

---

## Quick Start

### Requirements
- Windows 10/11 with CUDA GPU (CPU works but is slow)
- Python 3.10 or 3.11
- SA3 model weights (see Setup)

### Setup
```bash
cd stable-audio-3
python -m venv .venv
.venv\Scripts\activate
pip install -e .
```
Download the SA3 checkpoint (`small-music` or `medium`) from Hugging Face, or run `python scripts/localize_models.py` to pull from cache.

### Launch
```bash
.\run_server.bat
```
Pick a model from the menu, then open [http://localhost:7861](http://localhost:7861).

---

## Project Layout

```
sa3/
├── stable-audio-3/           # SA3 model library, virtualenv, localized weights
├── loopmaster/
│   └── loopmaster-app/       # Flask backend + JS/CSS/HTML frontend
│       ├── app_server.py     # API server & generation worker
│       └── static/           # Dashboard (index.html, app.js, app.css)
├── .wiki/                    # Knowledge base
│   ├── raw/                  # Immutable source documents
│   └── wiki/                 # Living compiled articles (concepts, topics, references)
├── run_server.bat            # Interactive launcher (model selector)
└── AGENTS.md                 # Agent operating rules
```

---

## Documentation

| Document | What's in it |
|----------|-------------|
| [Knowledge Base Index](.wiki/_index.md) | Entry point to all system and user documentation. |
| [User Guide](.wiki/wiki/topics/user_guide.md) | Every feature explained with workflows. Start here. |
| [Architecture](.wiki/wiki/concepts/architecture.md) | Signal chain, API contracts, DSP specs, generation pipeline. |

---

## Credits

**Model**: [Stable Audio 3](https://stability.ai/) by Stability AI

**DSP References**:
- [Luftikus EQ](https://github.com/lkjbdsp/lkjb-plugins/tree/master/Luftikus) — 6-band analog EQ
- [Valentine](https://github.com/tote-bag-labs/valentine) — Saturation & pumping compressor
- [Ælapse](https://github.com/smiarx/aelapse) — Tape delay & spring reverb
- [Scream](https://github.com/Cure-Audio/Scream) — Resonant distortion
- [Filtr](https://github.com/tiagolr/filtr) — Multi-type filter
