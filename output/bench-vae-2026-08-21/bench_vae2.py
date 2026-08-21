"""Corrected #9 benchmark: pinned-CPU decoded_batch WITH per-variant sync
(the naive non_blocking copy without sync corrupts data — proven in bench 1).
Runs both chunk_size 64 and 128 for GPU-resident vs pinned-CPU."""
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

def main():
    dev = torch.device("cuda:0")
    cfg_path = try_to_load_from_cache(repo_id=REPO, filename="model_config.json")
    ckpt_path = try_to_load_from_cache(repo_id=REPO, filename="model.safetensors")
    with open(cfg_path) as f:
        cfg = json.load(f)
    sample_rate = cfg["sample_rate"]
    ds_ratio = cfg["model"]["pretransform"]["config"]["downsampling_ratio"]
    latent_dim = cfg["model"]["pretransform"]["config"]["latent_dim"]

    ae = load_autoencoder(cfg_path, ckpt_path, device="cpu")
    ae = ae.eval().requires_grad_(False).half().to(dev)
    pretransform = AutoencoderPretransform(ae, scale=1.0, chunked=True).to(dev)

    latent_len = int(120.0 * sample_rate) // ds_ratio
    batch = 4
    g = torch.Generator(device="cpu").manual_seed(1234)
    latents = torch.randn(batch, latent_dim, latent_len, generator=g).half().to(dev)
    audio_len = latent_len * ds_ratio
    audio_mask_gpu = torch.ones(batch, 1, audio_len, dtype=torch.bool, device=dev)
    audio_mask_gpu[..., -sample_rate:] = False

    def run_gpu(chunk_size):
        with torch.inference_mode():
            decoded_batch = None
            for i in range(batch):
                d = pretransform.decode(latents[i:i+1], chunked=True, chunk_size=chunk_size)
                if decoded_batch is None:
                    decoded_batch = d.new_empty((batch, *d.shape[1:]))
                decoded_batch[i:i+1].copy_(d)
                del d
                torch.cuda.synchronize()  # report_variant syncs per variant in prod
            out = decoded_batch * audio_mask_gpu[..., :decoded_batch.shape[-1]].to(decoded_batch.dtype)
            out = torch.nan_to_num(out, nan=0.0, posinf=1.0, neginf=-1.0)
            out = out.to(torch.float32).clamp(-1, 1)
            cpu = out.to(device="cpu", dtype=torch.float32)
        return cpu

    def run_pinned(chunk_size):
        with torch.inference_mode():
            decoded_batch = None
            for i in range(batch):
                d = pretransform.decode(latents[i:i+1], chunked=True, chunk_size=chunk_size)
                d = d * audio_mask_gpu[i:i+1, ..., :d.shape[-1]].to(d.dtype)
                if decoded_batch is None:
                    decoded_batch = torch.empty(
                        (batch, *d.shape[1:]), dtype=d.dtype,
                        device="cpu", pin_memory=True,
                    )
                decoded_batch[i:i+1].copy_(d, non_blocking=True)
                torch.cuda.synchronize()  # REQUIRED before d's memory is reused
                del d
            out = torch.nan_to_num(decoded_batch, nan=0.0, posinf=1.0, neginf=-1.0)
            out = out.to(torch.float32).clamp(-1, 1)
        return out

    outs = {}
    for cs in (64, 128):
        for name, fn in (("gpu", run_gpu), ("pinned", run_pinned)):
            fn(cs)  # warmup
            times, peaks = [], []
            for _ in range(2):
                torch.cuda.reset_peak_memory_stats(dev)
                pre = torch.cuda.memory_allocated(dev)
                torch.cuda.synchronize(); t0 = time.perf_counter()
                out = fn(cs)
                torch.cuda.synchronize()
                times.append(time.perf_counter() - t0)
                peaks.append(torch.cuda.max_memory_allocated(dev) - pre)
            outs[(name, cs)] = out
            print(f"chunk {cs:3d} {name:6s}: median {statistics.median(times):.3f}s  "
                  f"peak-delta {max(peaks)/MiB:.0f} MiB")
        eq = (outs[("gpu", cs)] - outs[("pinned", cs)]).abs().max().item()
        print(f"chunk {cs:3d} equivalence gpu vs pinned: max|diff|={eq:.3e}")

if __name__ == "__main__":
    main()
