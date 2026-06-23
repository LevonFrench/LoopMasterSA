---
confidence: high
volatility: cold
---

# API Reference

This article documents the backend HTTP endpoints exposed by the Flask server in `app_server.py`.

---

## 1. POST /api/generate

Initializes a batch generation job for new audio tracks.

### Request Body (JSON)
| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | String | (Required) | The text description of the desired audio. |
| `bpm` | Integer | `120` | Tempo target. Stripped from prompt and appended as metadata. |
| `seed` | Integer | `-1` | Random seed. Set to `-1` for random generations. |
| `steps` | Integer | `8` | Number of diffusion sampling steps. |
| `duration` | Float | `8.0` | Target audio length in seconds. |
| `init_audio_path` | String | `null` | File path of the seed audio for remixes. |
| `init_noise_level`| Float | `0.6` | Noise multiplier (`0.10` to `0.90`) for variation remixes. |
| `remix_mode` | String | `"variation"`| Remix mode: `"variation"`, `"response"`, `"inpaint"`, or `"continuation"`. |
| `inpaint_start` | Float | `null` | Start boundary in seconds for inpainting. |
| `inpaint_end` | Float | `null` | End boundary in seconds for inpainting. |
| `continue_start` | Float | `null` | Split boundary in seconds for continuation. |
| `invert_timing` | Boolean | `false` | Reverse the timing of the seed audio before generating. |

### Response (JSON)
```json
{
  "job_id": "gen_20260621_084530_abcd"
}
```

---

## 2. GET /api/status/{job_id}

Queries the progress of an active generation job.

### Response (JSON)
- **Active / Running**:
  ```json
  {
    "status": "running",
    "progress": 0.5,
    "stage": "sampling"
  }
  ```
  *Possible stages*: `queued`, `loading_model`, `sampling`, `vae_start` (VAE decoding starting), `vae_end`, `complete`.
- **Complete**:
  ```json
  {
    "status": "complete",
    "variants": [
      "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_0_20260621.wav",
      "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_1_20260621.wav",
      "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_2_20260621.wav",
      "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_3_20260621.wav"
    ]
  }
  ```
- **Error**:
  ```json
  {
    "status": "failed",
    "error": "CUDA out of memory error during inference."
  }
  ```

---

## 3. POST /api/regenerate

Triggers regeneration of specific unlocked card slots.

### Request Body (JSON)
| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | String | (Required) | Text prompt to guide regeneration. |
| `bpm` | Integer | `120` | Tempo target. |
| `seed` | Integer | `-1` | Random seed. |
| `steps` | Integer | `8` | Diffusion steps. |
| `duration` | Float | `8.0` | Target duration. |
| `track_id` | Integer | (Required) | Target track ID. |
| `unlocked_indices`| Array of Int | (Required) | Array of card indexes (0-3) to regenerate. |
| `init_audio_path` | String | `null` | Base audio path for inpaint/continuation. |
| `remix_mode` | String | `null` | Remix mode config. |
| `inpaint_start` | Float | `null` | Inpaint range start. |
| `inpaint_end` | Float | `null` | Inpaint range end. |
| `continue_start` | Float | `null` | Continuation split point. |
| `invert_timing` | Boolean | `false` | Time reversal option. |

### Response (JSON)
```json
{
  "job_id": "regen_20260621_084610_wxyz"
}
```

---

## 4. POST /api/convert

Transcodes audio output files using local `ffmpeg`.

### Request Parameters (Multipart Form-Data or JSON)
- `file_path`: (Optional) Local path of the WAV file to convert.
- `file`: (Optional) Uploaded WAV audio file blob.
- `format`: Target format: `"mp3"` or `"ogg"`.

### Response (Audio Binary)
Returns the encoded MP3 or OGG file binary. High-quality variable bitrate configurations (`-q:a 2` for MP3, `-q:a 4` for OGG) are used.

---

## 5. POST /api/delete_variant

Deletes a specific variant file from the active session directory.

### Request Body (JSON)
```json
{
  "file_path": "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_2_20260621.wav"
}
```

### Response (JSON)
```json
{
  "status": "success",
  "deleted": "static/outputs/session_20260621_0345/track_1_dreamy_piano_var_2_20260621.wav"
}
```

## Related Documents
- `[[concepts/architecture|System Architecture]]` ([System Architecture](../concepts/architecture.md))
- `[[concepts/generation_pipeline|Generation Pipeline]]` ([Generation Pipeline](../concepts/generation_pipeline.md))
