"""Admin privilege helper for KJB users.

Usage:
  python op.py list
  python op.py list alice
  python op.py <email_prefix>
  python op.py <email_prefix> grant
  python op.py <email_prefix> revoke
  python op.py <email_prefix> toggle
"""

from __future__ import annotations

import argparse
import sys

from app import create_app
from app.extensions import db
from app.models import User


def _normalize_prefix(value: str) -> str:
    value = (value or "").strip().lower()
    if "@" in value:
        value = value.split("@", 1)[0]
    return value


def _find_user(prefix: str) -> User | None:
    return User.query.filter(User.email_prefix.ilike(prefix)).first()


def _list_users(prefix: str | None = None) -> int:
    query = User.query
    if prefix:
        query = query.filter(User.email_prefix.ilike(f"{prefix}%"))
    users = query.order_by(User.email_prefix.asc()).all()

    if not users:
        print("no users found")
        return 0

    for user in users:
        status = "admin" if user.is_admin else "regular"
        print(f"{user.email_prefix}\t{user.name}\t{status}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Grant, revoke, toggle, or list admin privilege by email prefix.")
    parser.add_argument("args", nargs="*", help="Use: list [prefix] or <email_prefix> [grant|revoke|toggle]")
    parsed = parser.parse_args(argv)

    if not parsed.args:
        parser.print_help()
        return 2

    if parsed.args[0] == "list":
        prefix = _normalize_prefix(parsed.args[1]) if len(parsed.args) > 1 else ""
        app = create_app()
        with app.app_context():
            return _list_users(prefix or None)

    prefix = _normalize_prefix(parsed.args[0])
    action = parsed.args[1] if len(parsed.args) > 1 else "toggle"
    if action not in {"grant", "revoke", "toggle"}:
        print(f"error: invalid action '{action}'", file=sys.stderr)
        return 2
    if not prefix:
        print("error: email_prefix is empty", file=sys.stderr)
        return 2

    app = create_app()
    with app.app_context():
        user = _find_user(prefix)
        if not user:
            print(f"error: user not found for prefix '{prefix}'", file=sys.stderr)
            return 1

        before = bool(user.is_admin)
        if action == "grant":
            user.is_admin = True
        elif action == "revoke":
            user.is_admin = False
        else:
            user.is_admin = not user.is_admin

        db.session.commit()

        after = "admin" if user.is_admin else "regular"
        action_label = {
            "grant": "granted",
            "revoke": "revoked",
            "toggle": "toggled",
        }[action]
        print(
            f"{action_label}: {user.name} ({user.email_prefix}) "
            f"{'admin' if before else 'regular'} -> {after}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
