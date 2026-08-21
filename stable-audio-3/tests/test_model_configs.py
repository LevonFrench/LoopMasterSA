from pathlib import Path

import pytest

from stable_audio_3 import model_configs


def _write_model_file(root: Path, repo_id: str, filename: str) -> Path:
    path = root / repo_id.rsplit("/", 1)[-1] / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"local-test-data")
    return path


def _reject_remote(*args, **kwargs):
    pytest.fail(f"unexpected remote model download: args={args}, kwargs={kwargs}")


def test_model_config_prefers_configured_local_model_root(monkeypatch, tmp_path):
    models_root = tmp_path / "models"
    config = _write_model_file(models_root, "example/model-repo", "config.json")
    checkpoint = _write_model_file(
        models_root, "example/model-repo", "model.safetensors"
    )
    monkeypatch.setenv("SA3_MODELS_DIR", str(models_root))
    monkeypatch.setattr(
        model_configs, "try_to_load_from_cache", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(model_configs, "hf_hub_download", _reject_remote)

    resolved = model_configs.ModelConfig(
        "example/model-repo", "config.json", "model.safetensors"
    ).resolve()

    assert resolved == (str(config), str(checkpoint))


def test_model_config_resolves_split_local_repositories(monkeypatch, tmp_path):
    models_root = tmp_path / "models"
    config = _write_model_file(models_root, "official/config-repo", "config.json")
    checkpoint = _write_model_file(
        models_root, "optimized/checkpoint-repo", "optimized.safetensors"
    )
    monkeypatch.setenv("SA3_MODELS_DIR", str(models_root))
    monkeypatch.setattr(
        model_configs, "try_to_load_from_cache", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(model_configs, "hf_hub_download", _reject_remote)

    resolved = model_configs.ModelConfig(
        "optimized/checkpoint-repo",
        "config.json",
        "optimized.safetensors",
        config_repo_id="official/config-repo",
    ).resolve()

    assert resolved == (str(config), str(checkpoint))


def test_model_config_uses_huggingface_cache_before_remote(monkeypatch, tmp_path):
    config = tmp_path / "cache" / "config.json"
    checkpoint = tmp_path / "cache" / "model.safetensors"
    config.parent.mkdir(parents=True)
    config.write_bytes(b"cached-config")
    checkpoint.write_bytes(b"cached-checkpoint")

    cached = {
        ("example/model-repo", "config.json"): str(config),
        ("example/model-repo", "model.safetensors"): str(checkpoint),
    }
    monkeypatch.setenv("SA3_MODELS_DIR", str(tmp_path / "empty-models"))
    monkeypatch.setattr(
        model_configs,
        "try_to_load_from_cache",
        lambda repo_id, filename: cached.get((repo_id, filename)),
    )
    monkeypatch.setattr(model_configs, "hf_hub_download", _reject_remote)

    resolved = model_configs.ModelConfig(
        "example/model-repo", "config.json", "model.safetensors"
    ).resolve()

    assert resolved == (str(config), str(checkpoint))


def test_model_config_probes_every_local_file_before_any_download(
    monkeypatch, tmp_path
):
    checkpoint = tmp_path / "cache" / "model.safetensors"
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b"cached-checkpoint")
    lookups = []

    def find_cached(repo_id, filename):
        lookups.append((repo_id, filename))
        if filename == "model.safetensors":
            return str(checkpoint)
        return None

    def download_missing(repo_id, filename):
        assert ("example/model-repo", "model.safetensors") in lookups
        assert filename == "config.json"
        return str(tmp_path / "downloaded-config.json")

    monkeypatch.setenv("SA3_MODELS_DIR", str(tmp_path / "empty-models"))
    monkeypatch.setattr(model_configs, "try_to_load_from_cache", find_cached)
    monkeypatch.setattr(model_configs, "hf_hub_download", download_missing)

    config, resolved_checkpoint = model_configs.ModelConfig(
        "example/model-repo", "config.json", "model.safetensors"
    ).resolve()

    assert config == str(tmp_path / "downloaded-config.json")
    assert resolved_checkpoint == str(checkpoint)
