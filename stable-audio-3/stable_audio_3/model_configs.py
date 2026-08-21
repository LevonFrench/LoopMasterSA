from dataclasses import dataclass
import os
from pathlib import Path

from huggingface_hub import hf_hub_download, try_to_load_from_cache


def _model_roots() -> tuple[Path, ...]:
    """Return local model roots in priority order."""
    configured_root = os.environ.get("SA3_MODELS_DIR")
    project_root = Path(__file__).resolve().parents[1] / "models"
    roots = [Path(configured_root).expanduser()] if configured_root else []
    roots.append(project_root)

    unique_roots = []
    seen = set()
    for root in roots:
        normalized = os.path.normcase(os.path.abspath(root))
        if normalized not in seen:
            seen.add(normalized)
            unique_roots.append(root)
    return tuple(unique_roots)


def _find_local_file(repo_id: str, filename: str) -> str | None:
    """Find a model file locally without making a network request."""
    repo_name = repo_id.rsplit("/", 1)[-1]
    for root in _model_roots():
        candidate = root / repo_name / filename
        if candidate.is_file():
            return str(candidate)

    cached = try_to_load_from_cache(repo_id=repo_id, filename=filename)
    if isinstance(cached, str) and os.path.isfile(cached):
        return cached
    return None


def _find_local_config(cfg_repo: str, ckpt_repo: str, filename: str) -> str | None:
    """Find a config locally, probing both repo folders before any HF cache."""
    repos = dict.fromkeys((cfg_repo, ckpt_repo))
    for repo_id in repos:
        repo_name = repo_id.rsplit("/", 1)[-1]
        for root in _model_roots():
            candidate = root / repo_name / filename
            if candidate.is_file():
                return str(candidate)

    for repo_id in repos:
        cached = try_to_load_from_cache(repo_id=repo_id, filename=filename)
        if isinstance(cached, str) and os.path.isfile(cached):
            return cached
    return None


@dataclass(frozen=True)
class ModelConfig:
    repo_id: str
    config_path: str
    ckpt_path: str
    config_repo_id: str = None

    def resolve(self):
        """Resolve each file locally before downloading only what is missing."""
        cfg_repo = self.config_repo_id if self.config_repo_id else self.repo_id
        config = _find_local_config(cfg_repo, self.repo_id, self.config_path)
        checkpoint = _find_local_file(self.repo_id, self.ckpt_path)

        if config is not None:
            print(f"[Local Model] Using config: {config}")
        else:
            config = hf_hub_download(repo_id=cfg_repo, filename=self.config_path)

        if checkpoint is not None:
            print(f"[Local Model] Using checkpoint: {checkpoint}")
        else:
            checkpoint = hf_hub_download(repo_id=self.repo_id, filename=self.ckpt_path)
        return config, checkpoint


@dataclass(frozen=True)
class AutoencoderModelConfig:
    """Config for a standalone autoencoder HF repo (e.g. stabilityai/SAME-S).

    resolve() first checks whether any full Stable Audio 3 checkpoint that contains the same
    autoencoder is already cached locally.  If one is found it is used as-is
    (load_autoencoder strips the pretransform.* prefix automatically), avoiding a
    redundant download.  Otherwise the lightweight AE-only repo is fetched instead.
    """

    ae_repo_id: str
    ae_config_path: str
    ae_ckpt_path: str
    stable_audio_3: tuple[ModelConfig, ...]

    def resolve(self):
        """Return (config_path, ckpt_path), preferring a local/cached Stable Audio 3 checkpoint or local autoencoder."""
        local_config = _find_local_file(self.ae_repo_id, self.ae_config_path)
        local_ckpt = _find_local_file(self.ae_repo_id, self.ae_ckpt_path)
        if local_config is not None and local_ckpt is not None:
            print(f"[Local Model] Using autoencoder config: {local_config}")
            print(f"[Local Model] Using autoencoder checkpoint: {local_ckpt}")
            return local_config, local_ckpt

        for fallback in self.stable_audio_3:
            config_repo = fallback.config_repo_id or fallback.repo_id
            fallback_config = _find_local_config(
                config_repo, fallback.repo_id, fallback.config_path
            )
            fallback_ckpt = _find_local_file(fallback.repo_id, fallback.ckpt_path)
            if fallback_config is not None and fallback_ckpt is not None:
                print(f"[Local Model] Using fallback config: {fallback_config}")
                print(f"[Local Model] Using fallback checkpoint: {fallback_ckpt}")
                return fallback_config, fallback_ckpt

        # No Stable Audio 3 checkpoint found in local cache — download the AE-only repo.
        config = local_config or hf_hub_download(
            repo_id=self.ae_repo_id, filename=self.ae_config_path
        )
        checkpoint = local_ckpt or hf_hub_download(
            repo_id=self.ae_repo_id, filename=self.ae_ckpt_path
        )
        return config, checkpoint


models: dict[str, ModelConfig] = {
    "small-music": ModelConfig(
        "stabilityai/stable-audio-3-small-music",
        "model_config.json",
        "model.safetensors",
    ),
    "small-music-base": ModelConfig(
        "stabilityai/stable-audio-3-small-music-base",
        "model_config.json",
        "model.safetensors",
    ),
    "small-sfx": ModelConfig(
        "stabilityai/stable-audio-3-small-sfx",
        "model_config.json",
        "model.safetensors",
    ),
    "small-sfx-base": ModelConfig(
        "stabilityai/stable-audio-3-small-sfx-base",
        "model_config.json",
        "model.safetensors",
    ),
    "medium": ModelConfig(
        "stabilityai/stable-audio-3-medium",
        "model_config.json",
        "model.safetensors",
    ),
    "medium-bf16": ModelConfig(
        "dummy9996/stable-audio-3-bf16-comfyui",
        "model_config.json",
        "stable_audio_3_medium-bf16.safetensors",
        config_repo_id="stabilityai/stable-audio-3-medium",
    ),
    "medium-base": ModelConfig(
        "stabilityai/stable-audio-3-medium-base",
        "model_config.json",
        "model.safetensors",
    ),
}

# Stable Audio 3 full-model configs to probe (in order) before downloading the AE-only repo.
_small_stable_audio_3: tuple[ModelConfig, ...] = (
    models["small-music"],
    models["small-sfx"],
)
_medium_stable_audio_3: tuple[ModelConfig, ...] = (
    models["medium"],
    models["medium-bf16"],
)

ae_models: dict[str, AutoencoderModelConfig] = {
    "same-s": AutoencoderModelConfig(
        ae_repo_id="stabilityai/SAME-S",
        ae_config_path="model_config.json",
        ae_ckpt_path="model.safetensors",
        stable_audio_3=_small_stable_audio_3,
    ),
    "same-l": AutoencoderModelConfig(
        ae_repo_id="stabilityai/SAME-L",
        ae_config_path="model_config.json",
        ae_ckpt_path="model.safetensors",
        stable_audio_3=_medium_stable_audio_3,
    ),
}

base_models: dict[str, ModelConfig] = {
    k: v for k, v in models.items() if k.endswith("-base")
}

all_models: dict[str, ModelConfig | AutoencoderModelConfig] = {
    **models,
    **ae_models,
}
