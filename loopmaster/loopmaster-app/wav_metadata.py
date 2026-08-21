import os
from copy import deepcopy
import json
import struct
import re
import time

from asset_contract import DEFAULT_LICENSE, GENERATOR_NAME, normalize_key

def is_drum_prompt(prompt):
    """
    Checks if the prompt describes a drum, percussion, or beat loop.
    Uses regex patterns to match standalone words to avoid substring false positives.
    """
    prompt_lower = prompt.lower()
    drum_patterns = [
        r'\bdrums?\b', r'\bperc(ussion)?s?\b', r'\bpercussive\b', 
        r'\bkick(s)?\b', r'\bsnare(s)?\b', r'\bhi-?hat(s)?\b', 
        r'\btom(s)?\b', r'\bclap(s)?\b', r'\bshaker(s)?\b', 
        r'\bbeats?\b', r'\bbreaks?\b', r'\bbreakbeats?\b', 
        r'\brhythms?\b', r'\bride(s)?\b', r'\bcrash(es)?\b', 
        r'\bcymbals?\b', r'\bbongos?\b', r'\bcongas?\b', 
        r'\btimbales?\b', r'\bcowbells?\b', r'\btambourines?\b', 
        r'\brimshots?\b', r'\bwoodblocks?\b', r'\bcabasa\b', 
        r'\bmaracas?\b', r'\bguiro\b', r'\bclaves?\b', 
        r'\btimpani\b', r'\bhats\b', r'\bdrumkit\b'
    ]
    return any(re.search(pattern, prompt_lower) for pattern in drum_patterns)

def parse_root_note(prompt):
    """
    Parses prompt string to extract musical key and map to MIDI root note.
    Returns 0xFFFF (Don't Transpose / Ignore) if no key matches.
    """
    key = normalize_key(prompt)
    if key:
        return key["rootMidi"]
    return 0xFFFF  # Ignore / Don't Transpose

def create_labl_chunk(cue_id, label_text):
    """Packs a 'labl' sub-chunk for the LIST adtl chunk."""
    label_bytes = label_text.encode('utf-8') + b'\x00' # Null-terminated
    # Align to even length
    if len(label_bytes) % 2 != 0:
        label_bytes += b'\x00'
    # Size is 4 bytes for Cue ID + label data size
    chunk_header = struct.pack('<4sII', b'labl', 4 + len(label_bytes), cue_id)
    return chunk_header + label_bytes

def create_adtl_list(labels):
    """Packs a LIST chunk of type adtl containing labl sub-chunks."""
    sub_chunks = b''
    for cue_id, text in labels:
        sub_chunks += create_labl_chunk(cue_id, text)
    # LIST size is 4 bytes list type ID + sub_chunks size
    list_header = struct.pack('<4sI4s', b'LIST', 4 + len(sub_chunks), b'adtl')
    return list_header + sub_chunks

def _riff_chunk(chunk_id, payload):
    padding = b'\x00' if len(payload) % 2 else b''
    return chunk_id + struct.pack('<I', len(payload)) + payload + padding


def create_info_list(
    prompt,
    bpm,
    *,
    name=None,
    key_display=None,
    software=None,
    created=None,
    license_text=DEFAULT_LICENSE,
):
    """Packs a LIST/INFO chunk so each WAV self-describes as a library asset.

    ICMT = the generation prompt, ISFT = software tag, ICRD = creation date.
    Readable by most DAWs and sample managers.
    """
    def sub(tag, text):
        # RIFF INFO is historically ANSI. The adjacent UTF-8 sidecar preserves
        # the full prompt without lossy replacement.
        data = str(text).encode("latin-1", "replace")[:4096] + b"\x00"
        return _riff_chunk(tag, data)

    sub_chunks = b""
    if name:
        sub_chunks += sub(b"INAM", name)
    if prompt:
        sub_chunks += sub(b"ICMT", prompt)
    software = software or f"{GENERATOR_NAME} ({int(round(bpm))} BPM)"
    sub_chunks += sub(b"ISFT", software)
    sub_chunks += sub(b"ICRD", (created or time.strftime("%Y-%m-%d"))[:10])
    sub_chunks += sub(b"ICOP", license_text)
    if key_display:
        sub_chunks += sub(b"IKEY", key_display)
    return struct.pack("<4sI4s", b"LIST", 4 + len(sub_chunks), b"INFO") + sub_chunks


def create_smpl_chunk(sample_rate, root_note, end_sample):
    """Create one forward sampler loop covering the full musical buffer."""
    unity_note = 60 if root_note == 0xFFFF else int(root_note)
    header = struct.pack(
        "<9I",
        0,  # manufacturer
        0,  # product
        int(round(1_000_000_000 / sample_rate)),
        unity_note,
        0,  # MIDI pitch fraction
        0,  # SMPTE format
        0,  # SMPTE offset
        1,  # sample loop count
        0,  # sampler data bytes
    )
    loop = struct.pack(
        "<6I",
        1,  # cue/loop identifier
        0,  # forward
        0,
        int(end_sample),
        0,  # fraction
        0,  # infinite play count
    )
    return _riff_chunk(b"smpl", header + loop)


def create_ckup_chunk(metadata_document):
    """Embed portable cache fields while keeping harmony data sidecar-only.

    WAV bytes cannot contain their own final hash/size without a circular value,
    so those two integrity fields remain sidecar-only as well.
    """
    musical = deepcopy(metadata_document.get("musical") or {})
    for field in ("chords", "chordSource", "chordsVerified"):
        musical.pop(field, None)
    audio = deepcopy(metadata_document.get("audio") or {})
    audio.pop("sha256", None)
    audio.pop("bytes", None)
    generation = deepcopy(metadata_document.get("generation") or {})
    progression_asset = generation.get("progression") is not None
    generation.pop("progression", None)
    if progression_asset:
        # Progressor prompts contain exact symbols and Roman formulas in their
        # composed/conditioned/enhanced forms.  Preserve portable non-harmony
        # prompt metadata while keeping all chord-bearing fields sidecar-only.
        prompt = generation.get("prompt")
        if isinstance(prompt, dict):
            raw_sections = prompt.get("sections")
            sections = deepcopy(raw_sections) if isinstance(raw_sections, dict) else {}
            for field in (
                "harmony",
                "progressionKey",
                "progressionId",
                "progression",
                "chordTrack",
            ):
                sections.pop(field, None)
            generation["prompt"] = {
                field: deepcopy(prompt[field])
                for field in ("negative", "userNegative")
                if field in prompt
            }
            generation["prompt"]["sections"] = sections
        else:
            generation.pop("prompt", None)
    payload = {
        "v": 1,
        "schema": "com.loopmaster.loop-cache",
        "id": metadata_document.get("id"),
        "kind": metadata_document.get("kind"),
        "metadataFile": metadata_document.get("metadataFile"),
        "naming": deepcopy(metadata_document.get("naming") or {}),
        "audio": audio,
        "musical": musical,
        "loopRegion": deepcopy(metadata_document.get("loopRegion")),
        "waveform": deepcopy(metadata_document.get("waveform") or {}),
        "slices": deepcopy(metadata_document.get("slices") or {}),
        "generation": generation,
        "provenance": deepcopy(metadata_document.get("provenance") or {}),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")
    return _riff_chunk(b"cKUP", encoded)


def pack_cue_chunk(cue_points):
    """Packs a 'cue ' chunk containing a list of cue points."""
    packed_points = b''
    for point in cue_points:
        # ID, Position, DataChunkID, ChunkStart, BlockStart, SampleOffset
        packed_points += struct.pack('<II4sIII', *point)
    num_cue_points = len(cue_points)
    chunk_size = 4 + (24 * num_cue_points)
    header = struct.pack('<4sII', b'cue ', chunk_size, num_cue_points)
    return header + packed_points

def find_data_chunk_offset(content):
    """Parses RIFF chunks to find the exact byte offset of the 'data' chunk."""
    offset = 12
    limit = len(content)
    while offset + 8 <= limit:
        chunk_id = content[offset:offset+4]
        chunk_size = struct.unpack('<I', content[offset+4:offset+8])[0]
        if chunk_id == b'data':
            return offset
        offset += 8 + chunk_size
        # Handle padding byte if size is odd
        if chunk_size % 2 != 0:
            offset += 1
    return None

def _walk_chunks(content):
    offset = 12
    while offset + 8 <= len(content):
        chunk_id = content[offset:offset + 4]
        size = struct.unpack_from("<I", content, offset + 4)[0]
        payload_start = offset + 8
        payload_end = payload_start + size
        padded_end = payload_end + (size % 2)
        if payload_end > len(content):
            raise ValueError(f"RIFF chunk {chunk_id!r} extends past end of file")
        yield chunk_id, content[payload_start:payload_end], content[offset:padded_end]
        offset = padded_end


def _wav_format(content):
    for chunk_id, payload, _raw in _walk_chunks(content):
        if chunk_id != b"fmt ":
            continue
        if len(payload) < 16:
            raise ValueError("WAV fmt chunk is too small")
        format_code, channels, sample_rate, _byte_rate, block_align, bits = struct.unpack_from(
            "<HHIIHH", payload, 0
        )
        return {
            "format": format_code,
            "channels": channels,
            "sample_rate": sample_rate,
            "block_align": block_align,
            "bits": bits,
        }
    raise ValueError("WAV is missing its fmt chunk")


def _metadata_cue_points(metadata_document, sample_rate, frame_count, bpm, beat_count, loop):
    if metadata_document:
        slices = metadata_document.get("slices") or {}
        points = list(slices.get("beatGrid") or []) + list(slices.get("transients") or [])
        result = []
        for point in points:
            sample = int(point.get("sample", -1))
            label = str(point.get("id") or "slice")
            if 0 <= sample < frame_count:
                result.append((sample, label))
        return result
    if not loop or not beat_count:
        return []
    samples_per_beat = (60.0 / bpm) * sample_rate
    return [
        (min(frame_count - 1, int(round(index * samples_per_beat))), f"beat_{index + 1}")
        for index in range(beat_count)
    ]


def acidize_wav_file(
    file_path,
    bpm,
    duration,
    loop=True,
    prompt="",
    metadata_document=None,
):
    """
    Inserts 'acid', 'cue ', and 'LIST' chunks BEFORE the 'data' chunk in a WAV file
    to set tempo, key, looping behavior, and beat transient markers without causing
    audio decoding noise at the end of the file.
    """
    with open(file_path, 'rb') as wav_file:
        content = wav_file.read()
    if content[:4] != b'RIFF' or content[8:12] != b'WAVE':
        raise ValueError("Invalid RIFF WAVE header")

    fmt = _wav_format(content)
    if fmt["format"] != 1 or fmt["bits"] != 16:
        raise ValueError("LoopMaster WAV output must be 16-bit PCM")
    chunks = list(_walk_chunks(content))
    data_payload = next((payload for chunk_id, payload, _raw in chunks if chunk_id == b"data"), None)
    if data_payload is None:
        raise ValueError("WAV is missing its data chunk")
    frame_count = len(data_payload) // fmt["block_align"]
    actual_duration = frame_count / float(fmt["sample_rate"])
    beat_count = int(round(actual_duration * float(bpm) / 60.0)) if loop and bpm else 0

    if metadata_document:
        # A supplied sidecar is authoritative, including an explicit null key.
        # Falling back to prompt parsing here could make ACID/IKEY contradict a
        # canonical `_nokey_` filename and sidecar.
        key_info = (metadata_document.get("musical") or {}).get("key")
    else:
        key_info = normalize_key(prompt)
    root_note = key_info["rootMidi"] if key_info else 0xFFFF
    acid_flags = (1 if loop else 0) | (2 if key_info else 0)
    acid_payload = struct.pack(
        "<IHHfIHHf",
        acid_flags,
        root_note,
        0,
        0.0,
        beat_count if loop else 0,
        4,
        4,
        float(bpm) if loop else 0.0,
    )
    metadata_chunks = [_riff_chunk(b"acid", acid_payload)]
    if metadata_document:
        metadata_chunks.append(create_ckup_chunk(metadata_document))

    cue_specs = _metadata_cue_points(
        metadata_document,
        fmt["sample_rate"],
        frame_count,
        float(bpm or 0),
        beat_count,
        loop,
    )
    if cue_specs:
        cue_points = []
        labels = []
        for index, (sample, label) in enumerate(cue_specs, start=1):
            cue_points.append((index, sample, b"data", 0, 0, sample))
            labels.append((index, label))
        metadata_chunks.extend((pack_cue_chunk(cue_points), create_adtl_list(labels)))

    if loop:
        metadata_chunks.append(create_smpl_chunk(fmt["sample_rate"], root_note, frame_count - 1))

    generation = (metadata_document or {}).get("generation") or {}
    provenance = (metadata_document or {}).get("provenance") or {}
    info_prompt = generation.get("prompt", {}).get("composed", prompt)
    info_name = (metadata_document or {}).get("id") or os.path.splitext(os.path.basename(file_path))[0]
    software = provenance.get("generator", GENERATOR_NAME)
    if loop:
        software = f"{software} ({int(round(float(bpm)))} BPM)"
    metadata_chunks.append(create_info_list(
        info_prompt,
        bpm or 0,
        name=info_name,
        key_display=key_info["display"] if key_info else None,
        software=software,
        created=provenance.get("createdAt"),
        license_text=provenance.get("license", DEFAULT_LICENSE),
    ))

    preserved_before_data = []
    data_and_after = []
    found_data = False
    for chunk_id, payload, raw in chunks:
        if chunk_id == b"data":
            found_data = True
            data_and_after.append(raw)
            continue
        if found_data:
            data_and_after.append(raw)
            continue
        if chunk_id in {b"acid", b"cue ", b"smpl", b"cKUP", b"id3 "}:
            continue
        if chunk_id == b"LIST" and payload[:4] in {b"adtl", b"INFO"}:
            continue
        preserved_before_data.append(raw)

    body = b"WAVE" + b"".join(preserved_before_data + metadata_chunks + data_and_after)
    new_content = b"RIFF" + struct.pack("<I", len(body)) + body
    with open(file_path, 'wb') as wav_file:
        wav_file.write(new_content)

    print(
        f"[WAV Metadata] Tagged '{os.path.basename(file_path)}': "
        f"tempo={float(bpm) if loop else 0:g}, root={root_note}, "
        f"beats={beat_count if loop else 0}, cues={len(cue_specs)}"
    )
    return {
        "sample_rate": fmt["sample_rate"],
        "channels": fmt["channels"],
        "bits": fmt["bits"],
        "frames": frame_count,
        "beats": beat_count if loop else 0,
        "cues": len(cue_specs),
    }

def enhance_prompt(prompt, bpm, duration, loop=True, engine="sa3"):
    """
    Enhances a prompt per the official SA3 prompting guide (mirrored at
    .wiki/raw/repos/sa3-upstream-docs/guides/prompting.md):
    1. Prepend a TrackType tag by keyword matching (the guide's three tags).
    2. Mention tempo once, inline as prose ("... , 120 BPM") — the guide shows
       BPM only as prose; it defines no "BPM:"/"Length:" tags, and duration is
       already a first-class generation parameter.
    3. Ensure ONE loop phrase when loop is checked (LoopMaster product concept;
       the guide is silent on looping).
    Quality boilerplate is no longer force-appended: the guide treats
    production character as something authored per prompt, not a fixed suffix.
    """
    if engine != "sa3":
        if loop and "loop" not in prompt.lower():
            return prompt + " loop"
        return prompt
    # Normalize any informal BPM mention; re-added once, in guide prose form, below.
    prompt = re.sub(r'\b(?:at\s+)?\d+\s*bpm\b', '', prompt, flags=re.IGNORECASE)
    # Clean up trailing "at" if it got orphaned (e.g. "slow loop at")
    prompt = re.sub(r'\bat\s*$', '', prompt, flags=re.IGNORECASE)
    # Clean up spacing around commas and duplicate commas
    prompt = re.sub(r'\s*,\s*', ', ', prompt)
    prompt = re.sub(r',\s*,', ',', prompt)
    prompt = prompt.strip().strip(",")
    prompt_lower = prompt.lower()
    
    # If the user has already manually tagged TrackType, bypass auto-classification
    if "tracktype:" in prompt_lower:
        final_prompt = prompt
    else:
        # 1. Classify TrackType
        sfx_keywords = [
            "sfx", "sound effect", "impact", "foley", "hit", "shatter", "glass break", 
            "explosion", "gunshot", "creak", "clatter", "thud", "whoosh", "swoosh", "zap",
            "ambient drone", "ambience", "drone", "environment", "noise",
            "thunder", "rain", "wind", "storm", "waves", "ocean", "river", "birds", "cricket"
        ]
        instrument_keywords = [
            "solo", "stem", "riff", "pluck", "lead", "bassline", "chords", "strum", 
            "drum loop", "perc loop", "percussion loop", "arpeggio", "groove loop",
            "synth", "guitar", "piano", "flute", "bass", "drum", "percussion", "brass",
            "trumpet", "violin", "cello", "saxophone", "rhodes", "organ", "clavinet"
        ]
        
        if any(re.search(rf'\b{re.escape(k)}\b', prompt_lower) for k in sfx_keywords):
            final_prompt = f"TrackType: SFX, {prompt}"
        elif any(re.search(rf'\b{re.escape(k)}\b', prompt_lower) for k in instrument_keywords) or (loop and "loop" in prompt_lower):
            final_prompt = f"TrackType: Instrument, {prompt}"
        else:
            final_prompt = f"TrackType: Music, VocalType: Instrumental, {prompt}"
            
    # 1.5 Default to SOLO instrumentation for instrument tracks unless otherwise specified
    if "tracktype: instrument" in final_prompt.lower():
        non_solo_keywords = [
            "solo", "duo", "trio", "quartet", "quintet", "ensemble", "band", 
            "orchestra", "symphony", "group", "session", "duet", "split", 
            "accompaniment", "backing", "chorus", "tutti", "multi"
        ]
        match = re.match(r'^(tracktype:\s*instrument,\s*)(.*)$', final_prompt, re.IGNORECASE)
        if match:
            prefix = match.group(1)
            prompt_content = match.group(2)
            content_lower = prompt_content.lower()
            if not any(k in content_lower for k in non_solo_keywords):
                final_prompt = f"{prefix}solo {prompt_content}"
        else:
            if not any(k in final_prompt.lower() for k in non_solo_keywords):
                final_prompt = "solo " + final_prompt
 
    # 2. Tempo, once, as inline prose per the guide ("Specify tempo, e.g. '120 BPM'").
    # Skipped for SFX: the guide never mentions tempo for samples/effects.
    if "tracktype: sfx" not in final_prompt.lower() and bpm:
        final_prompt += f", {int(bpm)} BPM"

    # 3. One loop phrase when looping (guide-silent; LoopMaster convention).
    if loop and "loop" not in final_prompt.lower():
        final_prompt += ", seamless loop"

    return final_prompt
