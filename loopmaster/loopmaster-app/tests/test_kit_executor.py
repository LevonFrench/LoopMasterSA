import threading
from types import SimpleNamespace

import torch

import kit_executor
from kit_executor import KitTask, _generate_batch, execute_kit_task


class _InferenceTensorModel:
    def __init__(self):
        self.last_kwargs = None

    def generate(self, **_kwargs):
        assert torch.is_inference_mode_enabled()
        self.last_kwargs = _kwargs
        return torch.ones((1, 1, 8), dtype=torch.float32)


def test_generate_batch_returns_mutable_cpu_tensor():
    runtime = SimpleNamespace(
        model=_InferenceTensorModel(),
        model_lock=threading.Lock(),
        mark_warm=lambda: None,
    )
    task = KitTask("job", "kit", "dry", ("kick",), ("medium",), seed=123)

    audio = _generate_batch(runtime, ["kick"], 1.0, task, seed_offsets=[7])

    assert audio.device.type == "cpu"
    assert not torch.is_inference(audio)
    assert runtime.model.last_kwargs["seed"] == 123
    assert runtime.model.last_kwargs["seed_offsets"] == [7]
    audio += 1
    assert audio[0, 0, 0].item() == 2


def test_kit_job_surfaces_partial_files(monkeypatch, tmp_path):
    updates = []

    def fake_generate(_runtime, prompts, _duration, _task, seed_offsets=None):
        assert seed_offsets is not None
        return torch.ones((len(prompts), 1, 20), dtype=torch.float32)

    def save_variant(path, *_args, **_kwargs):
        if "kickmedium" in path:
            raise OSError("simulated kick write failure")

    monkeypatch.setattr(kit_executor, "_generate_batch", fake_generate)
    runtime = SimpleNamespace(
        session_dir=str(tmp_path),
        session_dir_name="session_test",
        model=SimpleNamespace(model=SimpleNamespace(sample_rate=10)),
        slugify_prompt=lambda value, _length: value,
        save_variant_atomically=save_variant,
        update_job=lambda job_id, **changes: updates.append((job_id, changes)),
        prune_terminal_jobs=lambda **_kwargs: None,
        sliceable_registry=None,
    )
    task = KitTask(
        "job",
        "partial",
        "dry",
        ("kick", "snare"),
        ("medium",),
    )

    execute_kit_task(task, runtime)

    final = updates[-1][1]
    assert final["status"] == "done"
    assert len(final["files"]) == 1
    assert "partial_snaremedium_oneshot_nokey_a1.wav" in final["files"][0]
    assert final["partial_errors"] == [{
        "piece": "kick",
        "velocity": "medium",
        "variation": 1,
        "stage": "publishing",
        "error": "simulated kick write failure",
    }]
    assert [entry["piece"] for entry in final["kit"]["manifest"]["entries"]] == ["snare"]
    assert final["kit"]["manifest"]["entries"][0]["metadataFile"].endswith(".meta.json")
