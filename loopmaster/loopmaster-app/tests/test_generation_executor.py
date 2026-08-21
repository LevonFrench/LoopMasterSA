import threading
from pathlib import Path
from types import SimpleNamespace

import torch

import generation_executor
from generation_executor import (
    GenerationTask,
    ProgressionProvenance,
    _fit_audio_duration,
    _generate_audio,
    _load_seed_audio,
    _prepare_prompts,
    _publish_variants,
)
from chord_progressions import (
    canonical_chord_events,
    condition_prompt,
    resolve_progression,
)


class _InferenceTensorModel:
    def generate(self, **_kwargs):
        assert torch.is_inference_mode_enabled()
        return torch.arange(8, dtype=torch.float32).reshape(1, 1, 8)


def test_generate_audio_materializes_mutable_cpu_waveform():
    task = GenerationTask(
        job_id="job-1",
        prompt="test",
        bpm=120,
        duration=0.001,
        loop=True,
        steps=1,
        cfg_scale=1.0,
        track_num=1,
        num_variants=1,
    )
    runtime = SimpleNamespace(
        model=_InferenceTensorModel(),
        model_lock=threading.Lock(),
        mark_warm=lambda: None,
        update_job=lambda *_args, **_kwargs: None,
    )

    audio = _generate_audio(
        task,
        runtime,
        ["test"],
        seed_audio=None,
        padding_sec=0.0,
        target_indices=[0],
    )

    assert audio.device.type == "cpu"
    assert not torch.is_inference(audio)
    result = _fit_audio_duration(audio, duration=4, sample_rate=1, loop=True)
    assert result.tolist() == [[[4.0, 6.0, 8.0, 10.0]]]


def test_seed_audio_keeps_float32_cpu_copy_for_blending(monkeypatch, tmp_path):
    seed_path = tmp_path / "seed.wav"
    seed_path.write_bytes(b"stub")
    monkeypatch.setattr(
        generation_executor.torchaudio,
        "load",
        lambda _path: (torch.ones((1, 8), dtype=torch.float32), 22_050),
    )
    runtime = SimpleNamespace(
        resolve_output_path=lambda *_args: str(seed_path),
        model=SimpleNamespace(model_half=True, device="cpu"),
    )
    task = GenerationTask(
        job_id="job-2",
        prompt="test",
        bpm=120,
        duration=1,
        loop=False,
        steps=1,
        cfg_scale=1.0,
        track_num=2,
        init_audio_path="seed.wav",
    )

    seed_audio, blend_waveform, sample_rate = _load_seed_audio(task, runtime, 1)

    assert seed_audio[1].dtype == torch.float16
    assert blend_waveform.device.type == "cpu"
    assert blend_waveform.dtype == torch.float32
    assert sample_rate == 22_050


def test_keyed_drum_fill_oneshot_uses_nokey_filename_and_metadata(tmp_path):
    session_dir = tmp_path / "session_test"
    session_dir.mkdir()
    saved = []

    def save_variant(path, *_args, asset_metadata=None, **_kwargs):
        saved.append((Path(path).name, asset_metadata))
        Path(path).write_bytes(b"wav")
        Path(path).with_suffix(".meta.json").write_text("{}", encoding="utf-8")

    runtime = SimpleNamespace(
        session_dir=str(session_dir),
        session_dir_name="session_test",
        model=SimpleNamespace(model=SimpleNamespace(sample_rate=44_100)),
        save_variant_atomically=save_variant,
    )
    task = GenerationTask(
        job_id="job-drum",
        prompt="drum loop in C minor",
        bpm=120,
        duration=2,
        loop=True,
        steps=8,
        cfg_scale=1,
        track_num=1,
        num_variants=4,
        key="C minor",
        chords=({"bar": 1, "beat": 1, "chord": "c_min"},),
    )

    files, metadata_files, errors = _publish_variants(
        task,
        runtime,
        torch.zeros((1, 1, 88_200)),
        target_indices=[3],
        is_drum=True,
        prompts=["enhanced drum prompt"],
    )

    assert errors == []
    assert saved[0][0] == "loopmaster_loop_oneshot_nokey_d1.wav"
    assert saved[0][1]["key"] is None
    assert saved[0][1]["chords"] == []
    assert files[3].endswith("loopmaster_loop_oneshot_nokey_d1.wav")
    assert metadata_files[3].endswith("loopmaster_loop_oneshot_nokey_d1.meta.json")


def test_tonal_oneshot_preserves_its_key(tmp_path):
    session_dir = tmp_path / "session_test"
    session_dir.mkdir()
    saved = []

    def save_variant(path, *_args, asset_metadata=None, **_kwargs):
        saved.append((Path(path).name, asset_metadata))
        Path(path).write_bytes(b"wav")
        Path(path).with_suffix(".meta.json").write_text("{}", encoding="utf-8")

    runtime = SimpleNamespace(
        session_dir=str(session_dir),
        session_dir_name="session_test",
        model=SimpleNamespace(model=SimpleNamespace(sample_rate=44_100)),
        save_variant_atomically=save_variant,
    )
    task = GenerationTask(
        job_id="job-stab",
        prompt="orchestral stab in F# minor",
        bpm=120,
        duration=1,
        loop=False,
        steps=8,
        cfg_scale=1,
        track_num=2,
        num_variants=1,
        pack_name="cookout",
        descriptor="stabhit",
        key="Gb minor",
        chords=({"bar": 1, "beat": 1, "chord": "gb_min"},),
    )

    files, _metadata_files, errors = _publish_variants(
        task,
        runtime,
        torch.zeros((1, 1, 44_100)),
        target_indices=[0],
        is_drum=False,
        prompts=["enhanced stab prompt"],
    )

    assert errors == []
    assert saved[0][0] == "cookout_stabhit_oneshot_gbmin_a1.wav"
    assert saved[0][1]["key"] == "Gb minor"
    assert saved[0][1]["chords"] == [{"bar": 1, "beat": 1, "chord": "gb_min"}]
    assert files[0].endswith("cookout_stabhit_oneshot_gbmin_a1.wav")


def progression_task(**changes):
    resolution = resolve_progression("major_hopeful_01", "C major", bars=4)
    values = {
        "job_id": "job-progression",
        "prompt": "house drum loop in C major",
        "conditioned_prompt": condition_prompt(
            "house drum loop in C major", resolution
        ),
        "bpm": 120,
        "duration": 8,
        "loop": True,
        "steps": 8,
        "cfg_scale": 1,
        "track_num": 3,
        "num_variants": 4,
        "key": "C major",
        "chords": canonical_chord_events(resolution),
        "chord_source": "prompt",
        "progression": ProgressionProvenance.from_resolution(resolution),
        "prompt_sections": {
            "harmony": "Use Chord Progressor",
            "progressionId": "major_hopeful_01",
            "progressionKey": "C major",
        },
    }
    values.update(changes)
    return GenerationTask(**values)


def test_progression_conditions_every_model_prompt_and_disables_drum_fill():
    task = progression_task()
    enhanced_inputs = []
    runtime = SimpleNamespace(
        enhance_prompt=lambda prompt, _bpm, _duration, loop: (
            enhanced_inputs.append((prompt, loop)) or f"{prompt}|loop={loop}"
        ),
        is_drum_prompt=lambda _prompt: True,
    )

    indices, final_prompt, is_drum, prompts = _prepare_prompts(task, runtime)

    assert indices == [0, 1, 2, 3]
    assert is_drum is True
    assert enhanced_inputs == [(task.conditioned_prompt, True)]
    assert prompts == [final_prompt] * 4
    assert all("C - G - Am - F" in prompt for prompt in prompts)
    assert all("fill" not in prompt.lower() for prompt in prompts)


def test_progression_drum_variant_four_stays_a_loop_with_prompt_provenance(
    tmp_path,
):
    session_dir = tmp_path / "session_test"
    session_dir.mkdir()
    saved = []

    def save_variant(path, *_args, asset_metadata=None, **_kwargs):
        saved.append((Path(path).name, asset_metadata))
        Path(path).write_bytes(b"wav")
        Path(path).with_suffix(".meta.json").write_text("{}", encoding="utf-8")

    runtime = SimpleNamespace(
        session_dir=str(session_dir),
        session_dir_name="session_test",
        model=SimpleNamespace(model=SimpleNamespace(sample_rate=44_100)),
        save_variant_atomically=save_variant,
    )
    task = progression_task()

    files, metadata_files, errors = _publish_variants(
        task,
        runtime,
        torch.zeros((1, 1, 44_100 * 8)),
        target_indices=[3],
        is_drum=True,
        prompts=[f"{task.conditioned_prompt}, enhanced"],
    )

    assert errors == []
    filename, metadata = saved[0]
    assert filename == "loopmaster_loop_120bpm_cmaj_4bar_d1.wav"
    assert metadata["key"] == "C major"
    assert metadata["chords"] == list(task.chords)
    assert metadata["chord_source"] == "prompt"
    assert metadata["generation"]["progression"]["catalogId"] == (
        "major_hopeful_01"
    )
    assert metadata["generation"]["prompt"]["conditioned"] == (
        task.conditioned_prompt
    )
    assert files[3].endswith(filename)
    assert metadata_files[3].endswith(filename.replace(".wav", ".meta.json"))
