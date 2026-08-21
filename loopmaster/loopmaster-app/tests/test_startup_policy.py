from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_startup_warmup_is_opt_in_and_desktop_allows_model_downloads():
    server = (ROOT / "loopmaster" / "loopmaster-app" / "app_server.py").read_text(
        encoding="utf-8"
    )
    desktop = (ROOT / "loopmaster-desktop" / "main.js").read_text(
        encoding="utf-8"
    )

    assert '"--warmup"' in server
    assert "if args.warmup:\n        warmup_model()" in server
    assert "const STARTUP_TIMEOUT_MS = 600000;" in desktop
