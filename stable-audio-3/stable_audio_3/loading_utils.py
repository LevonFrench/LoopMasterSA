import json
import struct

import torch
from stable_audio_3.factory import (
    create_autoencoder_from_config,
    create_diffusion_cond_from_config,
)

_SAFETENSORS_DTYPES = {
    "F64": torch.float64,
    "F32": torch.float32,
    "F16": torch.float16,
    "BF16": torch.bfloat16,
    "I64": torch.int64,
    "I32": torch.int32,
    "I16": torch.int16,
    "I8": torch.int8,
    "U8": torch.uint8,
    "BOOL": torch.bool,
}


def read_safetensors_header(ckpt_path):
    """Return (header dict, data start offset) without touching tensor data."""
    with open(ckpt_path, "rb") as f:
        header_len = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(header_len))
    header.pop("__metadata__", None)
    return header, 8 + header_len


def iter_safetensors(ckpt_path, keys=None):
    """Yield (key, tensor) one at a time using plain buffered reads.

    Deliberately avoids safetensors' memory-mapped reader: on this Windows
    setup, mapping the 9GB medium checkpoint segfaults / fails with
    "paging file too small" (os error 1455) while normal reads work fine.
    Streaming also keeps peak memory at one tensor instead of the whole file.
    """
    header, data_start = read_safetensors_header(ckpt_path)
    wanted = header if keys is None else {k: header[k] for k in keys if k in header}
    with open(ckpt_path, "rb") as f:
        for key, meta in wanted.items():
            start, end = meta["data_offsets"]
            dtype = _SAFETENSORS_DTYPES[meta["dtype"]]
            if end == start:
                yield key, torch.empty(meta["shape"], dtype=dtype)
                continue
            f.seek(data_start + start)
            buffer = bytearray(f.read(end - start))
            yield key, torch.frombuffer(buffer, dtype=dtype).reshape(meta["shape"])


def copy_state_dict(model, state_dict):
    model_state_dict = model.state_dict()
    state_dict = remap_state_dict_keys(state_dict, model_state_dict)
    for key in state_dict:
        if (
            key in model_state_dict
            and state_dict[key].shape == model_state_dict[key].shape
        ):
            model_state_dict[key] = state_dict[key]
        else:
            print(
                f"Key {key} not found in target state_dict or shape mismatch. Skipping."
            )

    model.load_state_dict(model_state_dict, strict=False)


def load_autoencoder(config_path: str, ckpt_path: str, device: str = "cpu"):
    """Load only the autoencoder from a combined DiT+autoencoder checkpoint.

    Only pretransform tensors are read from disk. Standalone AE-only
    checkpoints (e.g. stabilityai/SAME-L / SAME-S) have no prefix.
    """

    with open(config_path) as f:
        config = json.load(f)

    autoencoder = create_autoencoder_from_config(config["model"], config["sample_rate"])

    # Full DiT checkpoints nest the AE under pretransform.model.*;
    # standalone AE-only checkpoints have no prefix.
    nested_prefix = "pretransform.model."
    header, _ = read_safetensors_header(ckpt_path)
    all_keys = list(header.keys())
    if any(k.startswith(nested_prefix) for k in all_keys):
        effective_prefix = nested_prefix
    else:
        effective_prefix = ""  # standalone AE — keys are already bare
    wanted_keys = [k for k in all_keys if k.startswith(effective_prefix)]
    state_dict = {
        key[len(effective_prefix):]: tensor
        for key, tensor in iter_safetensors(ckpt_path, keys=wanted_keys)
    }

    copy_state_dict(autoencoder, state_dict)
    return autoencoder.to(device)


def load_diffusion_cond(
    model_config,
    ckpt_path: str,
    device: str = "cuda",
    model_half: bool = False,
):
    model = create_diffusion_cond_from_config(model_config)
    model.eval().requires_grad_(False)
    # Convert and move the empty model to the target device BEFORE touching
    # the checkpoint, then stream tensors one at a time (copy_ converts dtype
    # and device per tensor). Holding the full fp32 model AND the whole 9GB
    # checkpoint in CPU commit at once crashed load on a 32GB machine.
    if model_half:
        model.half()
    model.to(device)
    model_state_dict = model.state_dict()
    for key, tensor in iter_safetensors(ckpt_path):
        target_key = key
        if target_key not in model_state_dict:
            parts = key.split(".")
            for i in range(1, len(parts)):
                candidate = ".".join(parts[:i]) + "." + ".".join(parts[i + 1:])
                if candidate in model_state_dict:
                    target_key = candidate
                    break
        destination = model_state_dict.get(target_key)
        if destination is None or destination.shape != tensor.shape:
            print(
                f"Key {key} not found in target state_dict or shape mismatch. Skipping."
            )
            continue
        with torch.no_grad():
            destination.copy_(tensor)
    return model


def remap_state_dict_keys(state_dict, model_state_dict):
    remapped = {}
    for key, value in state_dict.items():
        if key not in model_state_dict:
            parts = key.split(".")
            for i in range(1, len(parts)):
                candidate = ".".join(parts[:i]) + "." + ".".join(parts[i + 1 :])
                if candidate in model_state_dict:
                    key = candidate
                    break
        remapped[key] = value
    return remapped
