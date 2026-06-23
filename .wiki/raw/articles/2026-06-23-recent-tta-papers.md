---
title: "Recent Text-to-Audio Generation Models (2023-2024)"
source: "Academic Search"
type: "articles"
tags: ["audio-generation", "research", "latent-diffusion", "TTA"]
summary: "Overview of TTA and TTS generation evolution, shifting toward latent diffusion and end-to-end transformers."
---

# Recent Text-to-Audio Generation Models (2023-2024)

Research into text-to-audio (TTA) and text-to-speech (TTS) generation underwent significant evolution throughout 2023 and 2024, shifting from standard pipelines toward sophisticated latent diffusion models and end-to-end transformer architectures.

### Key Trends & Model Architectures (2023–2024)

*   **Latent Diffusion Models:** These became the dominant backbone for TTA. By mapping audio into a low-dimensional latent space (often via VAEs), these models generate high-fidelity audio conditioned on text encoders like CLAP, T5, or FLAN-T5.
    *   *Notable Examples:* **Make-An-Audio** (and its successor **Make-An-Audio 2**) introduced prompt-enhanced diffusion, while **AudioLDM** and **AudioGen** remained foundational references in the field.
*   **Integration of LLMs and Autoregressive Models:** Researchers increasingly bridged autoregressive language models with diffusion frameworks to gain both the flexibility of token-based generation and the high fidelity of diffusion-based refinement.
*   **End-to-End Speech Modeling:** The industry moved away from fragmented "ASR + LLM + TTS" pipelines toward unified, end-to-end speech language models (SpeechLMs) that directly process and generate audio waveforms.
*   **Explainability:** A newer focus emerged on making these black-box generative models more transparent. For example, **AudioGenX** was introduced to provide token-level explanations for why a model generates specific audio outputs based on textual prompts.

### Notable Research Papers & Frameworks

| Model/Paper | Focus Area | Key Contribution |
| :--- | :--- | :--- |
| **Make-An-Audio (2023)** | TTA | Introduced prompt-enhancement and latent diffusion for audio. |
| **AudioGen (2023)** | TTA | A foundational autoregressive model for high-quality audio. |
| **AudioGenX (2024)** | Explainability | Framework for explaining text-to-audio model decisions. |
| **Tango (2024)** | TTA | Instruction-guided latent diffusion for improved prompt adherence. |
| **SpeechLM Surveys (2024)** | Speech | Comprehensive overviews of end-to-end speech generation paradigms. |
| **AudioEditor (2025/Late 2024)** | Editing | Training-free audio editing using diffusion models. |

### Summary of Future Directions
Research in late 2024 and beyond has increasingly prioritized **controllability** (fine-grained control over pitch, energy, and timing), **temporal coherence** in long-form audio, and **multimodal integration** (aligning audio with visual or complex semantic inputs). Additionally, there is a strong shift toward **operationalization**—reducing latency and computing costs for real-time, "always-on" conversational voice agents.
