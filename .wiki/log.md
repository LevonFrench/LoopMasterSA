# Activity Log

## [2026-06-21] initialize_wiki | Initialized standard .wiki directory layout and migrated legacy documentation from loopmaster/wiki/ to root-level .wiki/ structure. Expanded articles covering system architecture, generation pipeline details, DSP & FX parameters, user guides, remix workflows, API specs, and modulation routing.

## [2026-06-21] electron_shell_and_refactor | Upgraded LoopMaster to a standalone Electron application (loopmaster-desktop) using a Smart Shell architecture to manage PyTorch subprocess lifecycles natively. Refactored the Python backend, merging redundant generation pipelines into a unified _execute_model_task handler and isolating ACID metadata/prompt logic into wav_metadata.py.
