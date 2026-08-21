import weakref
from pathlib import Path

import torch

from stable_audio_3.inference.sampling import _decode_variants_sequentially
from stable_audio_3.model import (
    StableAudioModel,
    _freeze_conditioning_tensors,
    _get_cond_key,
    _restore_conditioning_tensors,
)
from stable_audio_3.models.autoencoders import AudioAutoencoder


class _TrackingDecoder:
    def __init__(self, downsampling_ratio=1):
        self.downsampling_ratio = downsampling_ratio
        self._decoded_refs = []
        self.live_outputs_before_decode = []

    def decode(self, latents, **_kwargs):
        live_outputs = sum(ref() is not None for ref in self._decoded_refs)
        self.live_outputs_before_decode.append(live_outputs)
        decoded = latents.repeat_interleave(self.downsampling_ratio, dim=-1)
        self._decoded_refs.append(weakref.ref(decoded))
        return decoded


def test_chunked_decode_streams_chunks_into_one_output():
    decoder = _TrackingDecoder(downsampling_ratio=2)
    latents = torch.arange(9, dtype=torch.float32).reshape(1, 1, 9)

    decoded = AudioAutoencoder.decode_audio(
        decoder,
        latents,
        chunked=True,
        chunk_size=4,
        overlap=2,
    )

    expected = latents.repeat_interleave(2, dim=-1)
    torch.testing.assert_close(decoded, expected)
    assert max(decoder.live_outputs_before_decode) <= 1


def test_chunked_decode_rejects_nonpositive_hop():
    decoder = _TrackingDecoder()
    latents = torch.zeros(1, 1, 9)

    try:
        AudioAutoencoder.decode_audio(
            decoder,
            latents,
            chunked=True,
            chunk_size=4,
            overlap=4,
        )
    except ValueError as error:
        assert "chunk_size must be greater than overlap" in str(error)
    else:
        raise AssertionError("Expected invalid chunk settings to raise ValueError")


def test_variant_decode_streams_into_preallocated_batch():
    decoder = _TrackingDecoder()
    latents = torch.arange(24, dtype=torch.float32).reshape(4, 1, 6)
    progress = []

    decoded = _decode_variants_sequentially(
        decoder,
        latents,
        chunked_decode=True,
        on_variant=lambda completed, total: progress.append((completed, total)),
    )

    torch.testing.assert_close(decoded, latents)
    assert progress == [(1, 4), (2, 4), (3, 4), (4, 4)]
    assert max(decoder.live_outputs_before_decode) <= 1


def test_conditioning_cache_is_cpu_backed_and_restores_isolated_values():
    source = {
        "cross_attention": [torch.arange(4, dtype=torch.float32)],
        "timing": (torch.tensor([8.0]),),
    }

    frozen = _freeze_conditioning_tensors(source)
    restored = _restore_conditioning_tensors(frozen, torch.device("cpu"))

    assert frozen["cross_attention"][0].device.type == "cpu"
    assert frozen["cross_attention"][0].data_ptr() != source["cross_attention"][0].data_ptr()
    assert restored["cross_attention"][0].data_ptr() != frozen["cross_attention"][0].data_ptr()

    restored["inpaint_mask"] = [torch.ones(1)]
    restored["cross_attention"][0].add_(10)
    assert "inpaint_mask" not in frozen
    torch.testing.assert_close(
        frozen["cross_attention"][0],
        torch.arange(4, dtype=torch.float32),
    )


def test_conditioning_cache_key_separates_batch_device_and_dtype():
    key_args = {
        "prompt": "glass bells",
        "negative_prompt": "drums",
        "duration": 30,
    }
    baseline = _get_cond_key(
        **key_args,
        batch_size=1,
        device="cuda:0",
        dtype=torch.float16,
    )

    assert baseline != _get_cond_key(
        **key_args,
        batch_size=4,
        device="cuda:0",
        dtype=torch.float16,
    )
    assert baseline != _get_cond_key(
        **key_args,
        batch_size=1,
        device="cuda:1",
        dtype=torch.float16,
    )
    assert baseline != _get_cond_key(
        **key_args,
        batch_size=1,
        device="cuda:0",
        dtype=torch.float32,
    )


class _StubConditionedModel:
    def __init__(self):
        self.pretransform = None
        self.model = torch.nn.Linear(1, 1)


def test_conditioning_cache_is_scoped_to_model_instance():
    first = StableAudioModel(_StubConditionedModel(), {}, "cpu", False)
    second = StableAudioModel(_StubConditionedModel(), {}, "cpu", False)
    key = _get_cond_key(
        "glass bells",
        "drums",
        30,
        batch_size=1,
        device="cpu",
        dtype=torch.float32,
    )

    first._conditioning_cache[key] = ({"prompt": torch.ones(1)}, {})

    assert key not in second._conditioning_cache
    assert first._conditioning_cache is not second._conditioning_cache


def test_launchers_keep_medium_in_fp16_on_12gb_cards():
    root = Path(__file__).resolve().parents[2]
    browser_launcher = (root / "run_server.bat").read_text(encoding="utf-8")
    desktop_launcher = (root / "loopmaster-desktop" / "launcher.html").read_text(
        encoding="utf-8"
    )
    desktop_main = (root / "loopmaster-desktop" / "main.js").read_text(
        encoding="utf-8"
    )

    assert "--no-half" not in browser_launcher.lower()
    assert "Medium Model (Official - FP16" in browser_launcher
    assert 'value="medium">Medium Model (Official - FP16' in desktop_launcher
    assert "Medium Model (Official - FP32" not in desktop_launcher
    assert "const extraArgs = [];" in desktop_main
    assert "'--no-half'" not in desktop_main
    assert '"--no-half"' not in desktop_main
