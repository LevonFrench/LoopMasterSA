import os
import struct
import re

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
    prompt_lower = prompt.lower()
    
    # 1. Look for patterns like "key of C", "key: A#", "in F minor", "in Bb major"
    match = re.search(r'\b(?:key of|key:|in)\s+([a-g])\s*(#|b|sharp|flat)?', prompt_lower)
    if not match:
        # 2. Check for stand-alone keys like "C minor" or "A maj" at word boundaries
        match = re.search(r'\b([a-g])\s*(#|b|sharp|flat)?\s*(?:major|minor|maj|min|m)\b', prompt_lower)
        
    if match:
        note_name = match.group(1).upper()
        accidental = match.group(2)
        
        # Base midi notes (C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11)
        notes_map = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
        midi_base = notes_map.get(note_name, 0)
        
        if accidental:
            accidental = accidental.lower()
            if accidental in ['#', 'sharp']:
                midi_base += 1
            elif accidental in ['b', 'flat']:
                midi_base -= 1
                
        # Return note in octave 5 (60 is middle C)
        midi_note = 60 + midi_base
        # Wrap around to keep within [60, 71] octave range
        return (midi_note - 60) % 12 + 60
        
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

def acidize_wav_file(file_path, bpm, duration, loop=True, prompt=""):
    """
    Inserts 'acid', 'cue ', and 'LIST' chunks BEFORE the 'data' chunk in a WAV file
    to set tempo, key, looping behavior, and beat transient markers without causing
    audio decoding noise at the end of the file.
    """
    try:
        # Read the entire WAV file content
        with open(file_path, 'rb') as f:
            content = f.read()
            
        if content[:4] != b'RIFF' or content[8:12] != b'WAVE':
            print("[WAV Metadata] Invalid RIFF WAVE header")
            return
            
        # Parse sample rate from fmt chunk
        fmt_offset = None
        offset = 12
        limit = len(content)
        while offset + 8 <= limit:
            chunk_id = content[offset:offset+4]
            chunk_size = struct.unpack('<I', content[offset+4:offset+8])[0]
            if chunk_id == b'fmt ':
                fmt_offset = offset
                break
            offset += 8 + chunk_size
            if chunk_size % 2 != 0:
                offset += 1
                
        if fmt_offset is None:
            # Fallback to standard offset
            sample_rate = struct.unpack('<I', content[24:28])[0]
        else:
            # Sample rate is 12 bytes after the chunk ID in the 'fmt ' chunk
            sample_rate = struct.unpack('<I', content[fmt_offset+12:fmt_offset+16])[0]

        # Find the 'data' chunk offset
        data_offset = find_data_chunk_offset(content)
        if data_offset is None:
            print("[WAV Metadata] Could not locate 'data' chunk")
            return

        # Beat count comes from the clip's own length, not a fixed 16.
        # 8s at 120 BPM happens to be 16 beats, which is why the hardcoded
        # value looked correct at the defaults and was wrong everywhere else.
        beat_count = 0
        if bpm > 0 and duration and duration > 0:
            beat_count = int(round(float(duration) * float(bpm) / 60.0))

        # 1. Build 'acid' chunk
        acid_id = b"acid"
        acid_size = 24
        acid_type = 1 if loop else 0  # 1 = Loop, 0 = One-shot
        root_note = parse_root_note(prompt)
        reserved = 0
        num_beats = beat_count if loop else 0
        meter_num = 4.0
        meter_den = 4.0
        tempo = float(bpm)

        acid_payload = struct.pack("<IHHifff", acid_type, root_note, reserved, num_beats, meter_num, meter_den, tempo)
        acid_chunk = acid_id + struct.pack("<I", acid_size) + acid_payload

        # 2. Build 'cue ' and 'LIST' (adtl) chunks for the beat grid
        cue_points = []
        labels = []

        if loop and bpm > 0 and beat_count > 0:
            samples_per_beat = (60.0 / bpm) * sample_rate
            # one marker per beat, plus an end marker
            for i in range(beat_count + 1):
                pos = int(round(i * samples_per_beat))
                cue_id = i + 1
                label_name = f"Beat {cue_id}" if i < beat_count else "End"
                cue_points.append((cue_id, pos, b'data', 0, 0, pos))
                labels.append((cue_id, label_name))

            cue_chunk = pack_cue_chunk(cue_points)
            list_chunk = create_adtl_list(labels)
            metadata_block = acid_chunk + cue_chunk + list_chunk
        else:
            metadata_block = acid_chunk

        # Ensure metadata_block size is even
        if len(metadata_block) % 2 != 0:
            metadata_block += b'\x00'

        # 3. Assemble new WAV file content inserting metadata chunks BEFORE the 'data' chunk
        header = content[:data_offset]
        data_chunk = content[data_offset:]
        
        new_content = header + metadata_block + data_chunk
        
        # Update RIFF size at offset 4
        new_riff_size = len(new_content) - 8
        new_content = new_content[:4] + struct.pack("<I", new_riff_size) + new_content[8:]

        # Write back to file
        with open(file_path, 'wb') as f:
            f.write(new_content)
            
        print(f"[WAV Metadata] Successfully ACIDized WAV file '{os.path.basename(file_path)}' (inserted before data chunk):")
        print(f"               Tempo={bpm} BPM, RootNote={root_note if root_note != 0xFFFF else 'Ignore'}, Beats={num_beats}")
    except Exception as e:
        print(f"[WAV Metadata] Error writing metadata: {e}")

def enhance_prompt(prompt, bpm, duration, loop=True, engine="sa3"):
    """
    Enhances a prompt based on official Stability AI Stable Audio 3 guidelines:
    1. Prepend TrackType prefix based on keyword matching.
    2. Ensure loop/looping/seamless loop tags are present when loop is checked.
    3. Append high-quality acoustic/production tags.
    4. Append standard BPM and Length tags.
    """
    if engine != "sa3":
        if loop and "loop" not in prompt.lower():
            return prompt + " loop"
        return prompt
    # Remove any existing informal BPM descriptions like "120 bpm", "120bpm", "at 120 bpm" to avoid conflicting with structured metadata
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
 
    # 2. Integrate Looping keywords
    if loop:
        if "loop" not in final_prompt.lower():
            final_prompt += " loop"
            
    # 3. Add High Quality Acoustic & Spatial Descriptors
    quality_keywords = ["high fidelity", "studio", "clean", "mix", "stereo", "warmth", "analog"]
    if not any(q in final_prompt.lower() for q in quality_keywords):
        if "TrackType: SFX" in final_prompt:
            final_prompt += ", detailed texture, clean recording, high fidelity"
        elif "TrackType: Instrument" in final_prompt:
            final_prompt += ", clean studio recording, high fidelity, detailed texture"
        else:
            final_prompt += ", analog warmth, high fidelity, 44.1 kHz, stereo, well-mixed"
 
    # 4. Standardized BPM & Length formatting suffix using periods (dots) for Stability AI 3 guidelines
    duration_int = int(round(duration))
    if not final_prompt.endswith('.'):
        final_prompt += '.'
    final_prompt += f" BPM: {bpm}."
    if "length:" not in final_prompt.lower():
        final_prompt += f" Length: {duration_int} seconds."
        
    if loop:
        final_prompt += " seamless loop, looping"
        
    return final_prompt
