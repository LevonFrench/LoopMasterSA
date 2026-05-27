import os
import shutil
from huggingface_hub import hf_hub_download

MODELS = {
    "stable-audio-3-medium": {
        "repo_id": "stabilityai/stable-audio-3-medium",
        "files": ["model_config.json", "model.safetensors"]
    },
    "stable-audio-3-small-music": {
        "repo_id": "stabilityai/stable-audio-3-small-music",
        "files": ["model_config.json", "model.safetensors"]
    }
}

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # The models directory is under stable-audio-3/models
    sa3_dir = os.path.dirname(script_dir)
    models_dir = os.path.join(sa3_dir, "models")
    os.makedirs(models_dir, exist_ok=True)

    for folder_name, info in MODELS.items():
        repo_id = info["repo_id"]
        target_dir = os.path.join(models_dir, folder_name)
        os.makedirs(target_dir, exist_ok=True)

        print(f"\n--- Processing {repo_id} ---")
        for filename in info["files"]:
            target_path = os.path.join(target_dir, filename)
            
            # Check if file already exists in target directory
            if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
                print(f"  [Local] {filename} already exists at {target_path}")
                continue

            try:
                print(f"  Resolving {filename} from Hugging Face...")
                # hf_hub_download will check cache first; if cached, it returns instantly without downloading again
                cached_path = hf_hub_download(repo_id=repo_id, filename=filename)
                
                print(f"  Copying to local folder: {target_path}")
                shutil.copy2(cached_path, target_path)
                print(f"  [OK] Successfully localized {filename}")
            except Exception as e:
                print(f"  [Error] Failed to resolve {filename}: {e}")

if __name__ == "__main__":
    main()
