"""Benchmark for review findings #8 and #9 (VAE decode, sampling.py).

#8: chunk_size 64 vs 128 (overlap 32) — wall clock, peak VRAM, equivalence.
#9: GPU-resident vs pinned-CPU decoded_batch — peak VRAM, end-to-end time.
Plus: low-headroom empty_cache guard / OOM behavior under memory pressure.

Uses the SAME-L autoencoder weights from the locally cached
stabilityai/stable-audio-3-medium-base checkpoint, fp16 on CUDA
(production runs the pretransform in fp16 via model_half=True).
"""
import json
import statistics
import sys
import time

sys.path.insert(0, r"J:\projects\apps\sa3\stable-audio-3")

import torch
from huggingface_hub import try_to_load_from_cache

from stable_audio_3.loading_utils import load_autoencoder
from stable_audio_3.models.pretransforms import AutoencoderPretransform

REPO = "stabilityai/stable-audio-3-medium-base"
GiB = 1024 ** 3
MiB = 1024 ** 2

def mib(x):
    return x / MiB

def main():
    assert torch.cuda.is_available()
    dev = torch.device("cuda:0")
    free0, total = torch.cuda.mem_get_info(dev)
    print(f"[env] {torch.cuda.get_device_name(0)} free={free0/GiB:.2f}GiB total={total/GiB:.2f}GiB torch={torch.__version__}")

    cfg_path = try_to_load_from_cache(repo_id=REPO, filename="model_config.json")
    ckpt_path = try_to_load_from_cache(repo_id=REPO, filename="model.safetensors")
    assert isinstance(cfg_path, str) and isinstance(ckpt_path, str)

    with open(cfg_path) as f:
        cfg = json.load(f)
    sample_rate = cfg["sample_rate"]
    ds_ratio = cfg["model"]["pretransform"]["config"]["downsampling_ratio"]
    latent_dim = cfg["model"]["pretransform"]["config"]["latent_dim"]

    print("[load] loading autoencoder (fp32 cpu -> fp16 cuda)...")
    ae = load_autoencoder(cfg_path, ckpt_path, device="cpu")
    ae = ae.eval().requires_grad_(False).half().to(dev)
    pretransform = AutoencoderPretransform(ae, scale=1.0, chunked=True).to(dev)
    pretransform.downsampling_ratio = ds_ratio

    # Realistic worst case: 120 s @ 44.1 kHz (app default duration in model.generate)
    duration_s = 120.0
    latent_len = int(duration_s * sample_rate) // ds_ratio  # ~1292
    batch = 4
    print(f"[shape] latents B={batch} C={latent_dim} T={latent_len} "
          f"(~{latent_len*ds_ratio/1e6:.2f}M samples/variant @ {sample_rate}Hz)")

    g = torch.Generator(device="cpu").manual_seed(1234)
    latents = torch.randn(batch, latent_dim, latent_len, generator=g).half().to(dev)

    torch.cuda.synchronize()
    base_alloc = torch.cuda.memory_allocated(dev)
    print(f"[mem] allocated after model+latents: {mib(base_alloc):.0f} MiB")

    results = {}

    def timed_decode(chunk_size, runs=3):
        one = latents[0:1]
        with torch.inference_mode():
            # warmup
            out = pretransform.decode(one, chunked=True, chunk_size=chunk_size)
            torch.cuda.synchronize()
            del out
            times, peaks = [], []
            for _ in range(runs):
                torch.cuda.reset_peak_memory_stats(dev)
                pre = torch.cuda.memory_allocated(dev)
                torch.cuda.synchronize()
                t0 = time.perf_counter()
                out = pretransform.decode(one, chunked=True, chunk_size=chunk_size)
                torch.cuda.synchronize()
                times.append(time.perf_counter() - t0)
                peaks.append(torch.cuda.max_memory_allocated(dev) - pre)
                keep = out
                del out
            return statistics.median(times), max(peaks), keep

    # ---------- Finding #8: chunk_size 64 vs 128 ----------
    print("\n=== #8 chunk_size 64 vs 128 (overlap=32, single variant) ===")
    t64, p64, out64 = timed_decode(64)
    print(f"chunk 64 : median {t64:.3f}s  peak-delta {mib(p64):.0f} MiB")
    t128, p128, out128 = timed_decode(128)
    print(f"chunk 128: median {t128:.3f}s  peak-delta {mib(p128):.0f} MiB")
    print(f"speedup 128 vs 64: {t64 / t128:.2f}x")

    diff = (out64.float() - out128.float())
    ref_rms = out128.float().pow(2).mean().sqrt().item()
    max_abs = diff.abs().max().item()
    rms = diff.pow(2).mean().sqrt().item()
    print(f"equivalence 64 vs 128: max|diff|={max_abs:.3e} rms(diff)={rms:.3e} "
          f"signal rms={ref_rms:.3e} rel-rms={rms/max(ref_rms,1e-12):.3e}")

    # unchunked reference (may be large) — informative only
    try:
        with torch.inference_mode():
            torch.cuda.reset_peak_memory_stats(dev)
            pre = torch.cuda.memory_allocated(dev)
            torch.cuda.synchronize(); t0 = time.perf_counter()
            full = pretransform.decode(latents[0:1], chunked=False)
            torch.cuda.synchronize()
            tf = time.perf_counter() - t0
            pf = torch.cuda.max_memory_allocated(dev) - pre
        d64 = (out64.float() - full.float()).abs().max().item()
        d128 = (out128.float() - full.float()).abs().max().item()
        print(f"unchunked : {tf:.3f}s peak-delta {mib(pf):.0f} MiB  "
              f"max|64-full|={d64:.3e} max|128-full|={d128:.3e}")
        del full
    except torch.cuda.OutOfMemoryError:
        print("unchunked : OOM (informative only)")
        torch.cuda.empty_cache()
    del out64, out128
    torch.cuda.empty_cache()

    # ---------- Finding #9: GPU-resident vs pinned-CPU decoded_batch ----------
    print("\n=== #9 decoded_batch GPU vs pinned-CPU (B=4, chunk_size=64) ===")
    # fake audio_mask like sampling.py:618-625 (padding_mask non-None in prod)
    audio_len = latent_len * ds_ratio
    audio_mask_gpu = torch.ones(batch, 1, audio_len, dtype=torch.bool, device=dev)
    audio_mask_gpu[..., -sample_rate:] = False  # some padded tail

    def run_gpu_variant():
        """Current implementation: sampling.py _decode_variants_sequentially +
        batch mask multiply + fp32 conversion (model.py:510-511) + move to CPU
        (generation_executor.py:410-412)."""
        with torch.inference_mode():
            decoded_batch = None
            for i in range(batch):
                d = pretransform.decode(latents[i:i+1], chunked=True, chunk_size=64)
                if decoded_batch is None:
                    decoded_batch = d.new_empty((batch, *d.shape[1:]))
                decoded_batch[i:i+1].copy_(d)
                del d
            m = audio_mask_gpu
            if m.shape[-1] > decoded_batch.shape[-1]:
                m = m[..., :decoded_batch.shape[-1]]
            out = decoded_batch * m.to(decoded_batch.dtype)
            out = torch.nan_to_num(out, nan=0.0, posinf=1.0, neginf=-1.0)
            out = out.to(torch.float32).clamp(-1, 1)
            cpu = out.to(device="cpu", dtype=torch.float32)
        return cpu

    def run_cpu_variant():
        """Proposed: pinned-CPU decoded_batch, mask applied per-variant on GPU
        before the copy; fp32 conversion/clamp on CPU."""
        with torch.inference_mode():
            decoded_batch = None
            for i in range(batch):
                d = pretransform.decode(latents[i:i+1], chunked=True, chunk_size=64)
                m = audio_mask_gpu[i:i+1]
                if m.shape[-1] > d.shape[-1]:
                    m = m[..., :d.shape[-1]]
                d = d * m.to(d.dtype)
                if decoded_batch is None:
                    decoded_batch = torch.empty(
                        (batch, *d.shape[1:]), dtype=d.dtype,
                        device="cpu", pin_memory=True,
                    )
                decoded_batch[i:i+1].copy_(d, non_blocking=True)
                del d
            torch.cuda.synchronize()
            out = torch.nan_to_num(decoded_batch, nan=0.0, posinf=1.0, neginf=-1.0)
            out = out.to(torch.float32).clamp(-1, 1)
        return out

    for name, fn in (("gpu-resident", run_gpu_variant), ("pinned-cpu", run_cpu_variant)):
        fn()  # warmup
        torch.cuda.synchronize()
        times, peaks = [], []
        for _ in range(2):
            torch.cuda.reset_peak_memory_stats(dev)
            pre = torch.cuda.memory_allocated(dev)
            torch.cuda.synchronize(); t0 = time.perf_counter()
            out = fn()
            torch.cuda.synchronize()
            times.append(time.perf_counter() - t0)
            peaks.append(torch.cuda.max_memory_allocated(dev) - pre)
        results[name] = (statistics.median(times), max(peaks), out)
        print(f"{name:13s}: median {results[name][0]:.3f}s  peak-delta {mib(results[name][1]):.0f} MiB")

    eq = (results["gpu-resident"][2] - results["pinned-cpu"][2]).abs().max().item()
    print(f"equivalence gpu vs pinned-cpu: max|diff|={eq:.3e}")
    results["gpu-resident"] = results["gpu-resident"][:2]
    results["pinned-cpu"] = results["pinned-cpu"][:2]
    torch.cuda.empty_cache()

    # ---------- Memory-pressure / guard check ----------
    print("\n=== low-headroom guard + chunk-128 behavior under DiT-sized pressure ===")
    # Emulate the resident fp16 DiT (~4.3 GiB) + leave < 2 GiB free to force
    # the sampling.py:577-580 empty_cache branch.
    free, _ = torch.cuda.mem_get_info(dev)
    filler_bytes = int(free - 1.5 * GiB)
    filler = torch.empty(filler_bytes // 2, dtype=torch.float16, device=dev)
    free, _ = torch.cuda.mem_get_info(dev)
    print(f"pressure: free={free/GiB:.2f}GiB -> guard (free < 2GiB) fires: {free < 2*GiB}")
    if free < 2 * GiB:
        torch.cuda.empty_cache()  # what sampling.py does
    for cs in (64, 128):
        try:
            with torch.inference_mode():
                torch.cuda.synchronize(); t0 = time.perf_counter()
                out = pretransform.decode(latents[0:1], chunked=True, chunk_size=cs)
                torch.cuda.synchronize()
                print(f"chunk {cs:3d} under pressure: OK ({time.perf_counter()-t0:.3f}s)")
                del out
        except torch.cuda.OutOfMemoryError:
            print(f"chunk {cs:3d} under pressure: OOM")
            torch.cuda.empty_cache()
    del filler
    torch.cuda.empty_cache()

    print("\n[done]")

if __name__ == "__main__":
    main()
