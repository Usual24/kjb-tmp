#!/usr/bin/env python3
"""Generate VAPID keys, update local env settings, and check push connectivity."""

from __future__ import annotations

import argparse
import base64
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
PRIVATE_KEY_PATH = ROOT / "vapid_private.pem"
DEFAULT_EMAIL = "mailto:dev@usual24.us"
CHECK_HOSTS = [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def load_private_key(path: Path):
    with path.open("rb") as handle:
        return serialization.load_pem_private_key(handle.read(), password=None)


def generate_private_key(path: Path):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path.write_bytes(pem)
    return key


def ensure_private_key(path: Path):
    if path.exists():
        return load_private_key(path)
    return generate_private_key(path)


def public_key_value(private_key) -> str:
    public_key = private_key.public_key()
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return b64url(raw)


def update_env_file(env_path: Path, private_key_path: Path, public_key: str, email: str):
    lines = []
    if env_path.exists():
        with env_path.open("r", encoding="utf-8") as handle:
            lines = [line.rstrip("\n") for line in handle]

    updated = {
        "VAPID_PUBLIC_KEY": public_key,
        "VAPID_PRIVATE_KEY_FILE": str(private_key_path),
        "VAPID_CLAIMS_EMAIL": email,
    }

    existing = {}
    preserved = []
    for line in lines:
      stripped = line.strip()
      if not stripped or stripped.startswith("#") or "=" not in stripped:
          preserved.append(line)
          continue
      key, _ = stripped.split("=", 1)
      if key in updated:
          existing[key] = True
          preserved.append(f"{key}={updated[key]}")
      else:
          preserved.append(line)

    for key, value in updated.items():
        if key not in existing:
            preserved.append(f"{key}={value}")

    env_path.write_text("\n".join(preserved) + "\n", encoding="utf-8")


def check_connectivity(host: str, timeout: float = 5.0):
    url = f"https://{host}/"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return True, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        # A non-200 still means TLS/DNS/connectivity worked.
        return True, f"HTTP {exc.code}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--email",
        default=DEFAULT_EMAIL,
        help="VAPID claims email, e.g. mailto:dev@usual24.us",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when push service connectivity fails.",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Only check push service connectivity without writing files.",
    )
    args = parser.parse_args(argv)

    print("Checking push service connectivity...")
    all_ok = True
    for host in CHECK_HOSTS:
        ok, detail = check_connectivity(host)
        status = "OK" if ok else "FAIL"
        print(f"  - {host}: {status} ({detail})")
        all_ok &= ok

    if args.check_only:
        return 0 if all_ok else 1

    private_key = ensure_private_key(PRIVATE_KEY_PATH)
    public_key = public_key_value(private_key)
    update_env_file(ENV_PATH, PRIVATE_KEY_PATH, public_key, args.email)

    print(f"Updated {ENV_PATH}")
    print(f"Updated {PRIVATE_KEY_PATH}")
    print(f"VAPID_PUBLIC_KEY={public_key}")
    print(f"VAPID_PRIVATE_KEY_FILE={PRIVATE_KEY_PATH}")
    print(f"VAPID_CLAIMS_EMAIL={args.email}")

    if args.strict and not all_ok:
        print("Connectivity check failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
