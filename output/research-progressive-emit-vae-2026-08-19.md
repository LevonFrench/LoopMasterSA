# Research: VAE decode speed + progressive variant delivery (2026-08-19)

Collected by a crossed Claude session (3 cited research agents); preserved verbatim.

## 5. RESEARCH — all three angles returned

The owner asked for research on speeding up VAE decode and on showing each
variant as soon as it renders. Three agents were dispatched and **all three
reported**. Findings below.

**None of it has been tested against LoopMaster's own GPU.** Every performance
number is someone else's, from a named source, on their hardware. Treat the
whole section as a reading list with citations, not as measurements.

### Returned: progressive delivery to the browser

Sourced findings worth keeping:

- **Flask streaming**: headers must be fully set before the generator yields
  anything. `request` is not available inside the generator unless wrapped in
  `stream_with_context()`. Flask's own docs warn some WSGI middleware breaks
  streaming — debug-mode profilers included.
  (https://flask.palletsprojects.com/en/stable/patterns/streaming/)
- **SSE has no built-in "done"**. `EventSource` auto-reconnects after any
  disconnect, so if the server just closes, the browser reopens and can
  re-trigger the job. You must send a terminal event and have the client call
  `.close()`. Also a 6-concurrent-connection-per-tab cap on HTTP/1.1.
  (https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- **NDJSON over `fetch`** is the lighter alternative: `response.body` is a
  `ReadableStream`, read with `.getReader()`, decode, split on `\n`. Cuts
  time-to-first-record to first-packet latency.
  (https://blog.pamelafox.org/2023/08/fetching-json-over-streaming-http.html)
- **Real risk flag**: PyTorch issue #96036 reports a blocking C++-backed
  `future.wait()` holding the GIL and stalling other Python threads. Unresolved,
  and specific to `torch.distributed.rpc` — but it means "a background thread
  lets the SSE response keep flowing" must be smoke-tested against LoopMaster's
  actual `model.generate()` call, not assumed.
  (https://github.com/pytorch/pytorch/issues/96036)
- The agent's own suggested shape (its synthesis, not sourced): job kicked off in
  a `ThreadPoolExecutor` with one worker, SSE route returns immediately and polls
  shared state, files written to a temp name and `os.rename()`d so a partial file
  is never served, URLs only ever handed to the client after the server confirms
  they exist — which sidesteps the "browser caches a 404" problem. Low-risk
  fallback is a plain `GET /jobs/<id>` returning `{"ready": 3, "total": 8}`.

### Returned: VAE decode speed

**Lead finding: decode is not clearly the wall-clock bottleneck, but it IS the
VRAM bottleneck.** Stable Audio Open paper, Appendix B: *"During diffusion the
DiT utilizes 5.9 GB VRAM. During decoding, rendering waveforms from latents,
[VRAM] usage increases to 14.5 GB."* (arXiv 2407.14358v2). No source found gives
a clean diffusion-seconds vs decode-seconds split for stable-audio-tools on a
consumer GPU — so any claim that decode dominates *time* is currently
unevidenced.

- **The real chunked-decode API** is
  `AudioAutoencoder.decode_audio(latents, chunked=False, overlap=32, chunk_size=128)`
  in `stable_audio_tools/models/autoencoders.py`. Note this is a different knob
  from the `"chunked_decode": True` kwarg `generation_executor.py` already
  passes into `model.generate()` — **check which one actually reaches the
  autoencoder, and with what `overlap`/`chunk_size`.** That is a five-minute
  code trace and it may show the tuning is already partly done.
- Chunk sizing is **non-linear and GPU-dependent**. The docstring's own example:
  on an A6000, `chunk_size=128` was overall faster than 256 *and* 512. Do not
  assume bigger is faster.
- Seam artifacts: overlap must be ≥ the decoder's receptive field. The SAO paper
  measures that field at **16 latents per side** for its model; the shipped
  default `overlap=32` clears it. The docstring's recommended verification is to
  diff chunked vs unchunked output and look at max difference.
- SA3 README gives one concrete chunking saving: medium model at 120s drops from
  **6.49 GB to ~5.14 GB** peak VRAM.
- **Attention backends are irrelevant here.** `OobleckEncoder`/`OobleckDecoder`
  are purely convolutional (WNConv1d, ResidualUnit, snake activation) with **no
  attention layers at all**. xformers / SDPA / flash-attention only matter for
  the diffusion transformer. Drop that line of investigation for decode.
- `@torch.compile` exists in `autoencoders.py` but is **commented out**. No
  measured speedup for this decoder in any source. Worth testing; compile-time
  cost unknown and could dominate a single 8-variant job unless warmed.
- **fp16 is NOT a cheap win — do not just flip it.** No source establishes
  whether the Oobleck audio decoder is fp16-safe. The one precedent found
  (`madebyollin/sdxl-vae-fp16-fix`, which exists because SDXL's VAE NaNs in
  fp16) is a structurally different image VAE. bf16 is the lower-risk of the two
  if the GPU supports it, but this needs a NaN-checked experiment on real output.

### Returned: batch structure — and the answer that matters

**Progressive emit is structurally possible with the existing public API. This
is the key finding.**

- `generate_diffusion_cond(model, steps, cfg_scale, conditioning, ...,
  batch_size: int = 1, sample_size: int = 2097152, ...)` builds noise as one
  `[batch_size, io_channels, latent_sample_size]` tensor and has a
  **`return_latents` flag** — it passes `decode=not return_latents` down into
  `sample_diffusion`.
- In `stable_audio_tools/inference/sampling.py`, decode is exactly this, once,
  on the whole batch:
  ```python
  if decode and pretransform is not None:
      sampled = sampled.to(next(pretransform.parameters()).dtype)
      sampled = pretransform.decode(sampled)
  ```
  There is no per-sample loop. **Confirms all 8 decode together in the stock
  path.**
- Because `pretransform.decode()` is a plain shape-generic tensor call, the
  pattern *diffuse all 8 as one tensor via `return_latents=True` → slice the
  latent along dim 0 → decode each slice → emit as each finishes* is buildable
  today. **No one appears to have built it** — not in stable-audio-tools, not in
  its known forks, not in `run_gradio.py`. Treat it as unproven but available.
- Diffusers ships the image-domain precedent for exactly this shape:
  `enable_vae_slicing()` decodes a batch one item at a time, documented cost
  *"about 10%"* throughput. There is **no audio equivalent flag** in
  stable-audio-tools.
- Bonus: since decode is the VRAM peak, decoding per-variant is a memory-safety
  win as well as a latency win. Community OOM reports on Stable Audio Open show
  the crash landing inside the autoencoder's snake activation during
  `pretransform.decode()` — not during sampling.

**RISK, and it is a real one: batching may change the audio.** Same seed,
different batch size, produces non-identical output in the adjacent Stable
Diffusion image ecosystem (AUTOMATIC1111 issue #376; #10847 reports it varies by
sampler). **UNKNOWN whether stable-audio-tools' samplers behave the same way.**
Since it shares k-diffusion lineage, assume they might. Before switching
LoopMaster between batched and per-variant strategies, run the direct test:
generate variant #1 both ways with the same seed and diff the waveforms. If they
differ, changing the strategy changes what users hear on a re-roll.

## Suggested next steps

1. Load the app, confirm card playheads move.
2. Export a mix, parse the WAV chunks, confirm acid/cue/LIST are present and the
   beat count matches tempo x length.
3. Decide the loop flag question in §3.
4. Trace which chunked-decode setting actually reaches `decode_audio()` — the
   `"chunked_decode": True` kwarg in `generation_executor.py` versus the
   autoencoder's own `chunked`/`overlap`/`chunk_size`. Cheap, and it tells you
   whether there is anything left to tune.
5. Before designing progressive emit, run the batch-invariance test: same seed,
   variant #1 batched versus alone, diff the waveforms. If they differ, the
   feature changes what users hear and that is a product decision, not a
   technical one.

## Provenance

Research was 3 parallel Sonnet agents, briefed to cite a URL per claim and to
write UNKNOWN rather than guess. Where two sources conflicted or a number could
not be traced to a primary page, that is stated inline above rather than
resolved by picking one. Nothing here has been run against LoopMaster's own GPU
or measured locally — every performance claim is someone else's number, from a
named source, on their hardware.
