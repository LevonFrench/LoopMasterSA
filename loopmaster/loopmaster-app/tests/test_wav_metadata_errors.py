"""Malformed-WAV coverage for the ValueError paths in wav_metadata.acidize_wav_file."""

from pathlib import Path
import struct
import sys

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from wav_metadata import acidize_wav_file


def _chunk(chunk_id, payload):
    padding = b"\x00" if len(payload) % 2 else b""
    return chunk_id + struct.pack("<I", len(payload)) + payload + padding


def _riff(*chunks):
    body = b"WAVE" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _fmt_payload(format_code=1, channels=2, sample_rate=44_100, bits=16):
    block_align = channels * (bits // 8)
    return struct.pack(
        "<HHIIHH",
        format_code,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        bits,
    )


_PCM16_FMT = _chunk(b"fmt ", _fmt_payload())
_DATA = _chunk(b"data", b"\x00\x00\x00\x00" * 4)


MALFORMED_WAVS = [
    pytest.param(
        b"JUNK" + struct.pack("<I", 4) + b"WAVE",
        "Invalid RIFF WAVE header",
        id="bad-riff-magic",
    ),
    pytest.param(
        b"RIFF" + struct.pack("<I", 4) + b"WAVX" + _PCM16_FMT + _DATA,
        "Invalid RIFF WAVE header",
        id="bad-wave-tag",
    ),
    pytest.param(
        b"RIFF"
        + struct.pack("<I", 100)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<I", 100)
        + _fmt_payload(),
        "extends past end of file",
        id="truncated-chunk-size",
    ),
    pytest.param(
        _riff(_chunk(b"fmt ", _fmt_payload()[:12]), _DATA),
        "WAV fmt chunk is too small",
        id="fmt-payload-under-16-bytes",
    ),
    pytest.param(
        _riff(_DATA),
        "WAV is missing its fmt chunk",
        id="missing-fmt-chunk",
    ),
    pytest.param(
        _riff(_chunk(b"fmt ", _fmt_payload(format_code=3, bits=32)), _DATA),
        "must be 16-bit PCM",
        id="float32-fmt",
    ),
    pytest.param(
        _riff(_chunk(b"fmt ", _fmt_payload(bits=24)), _DATA),
        "must be 16-bit PCM",
        id="pcm24-fmt",
    ),
    pytest.param(
        _riff(_PCM16_FMT),
        "WAV is missing its data chunk",
        id="missing-data-chunk",
    ),
]


@pytest.mark.parametrize("content, match", MALFORMED_WAVS)
def test_acidize_rejects_malformed_wav(tmp_path, content, match):
    wav_path = tmp_path / "malformed.wav"
    wav_path.write_bytes(content)
    original = wav_path.read_bytes()

    with pytest.raises(ValueError, match=match):
        acidize_wav_file(str(wav_path), bpm=120.0, duration=2.0, loop=True)

    # A rejected file must not be partially rewritten.
    assert wav_path.read_bytes() == original
