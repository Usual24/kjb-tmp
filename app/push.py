import json

from flask import current_app
from requests import RequestException

from .extensions import db
from .models import PushSubscription

try:
    from pywebpush import WebPushException, webpush
except ImportError:  # pragma: no cover - optional dependency
    webpush = None

    class WebPushException(Exception):
        pass


def webpush_enabled():
    return bool(
        webpush
        and current_app.config.get("VAPID_PUBLIC_KEY")
        and current_app.config.get("VAPID_PRIVATE_KEY")
    )


def upsert_subscription(user, subscription_payload):
    endpoint = (subscription_payload or {}).get("endpoint", "").strip()
    if not endpoint:
        return None
    record = PushSubscription.query.filter_by(endpoint=endpoint).first()
    if not record:
        record = PushSubscription(
            user_id=user.id,
            endpoint=endpoint,
            subscription_json=json.dumps(subscription_payload),
        )
        db.session.add(record)
    else:
        record.user_id = user.id
        record.subscription_json = json.dumps(subscription_payload)
    return record


def remove_user_subscriptions(user):
    PushSubscription.query.filter_by(user_id=user.id).delete()


def send_web_push(user, payload):
    if not user or not user.browser_notifications_enabled or not webpush_enabled():
        return 0

    subscriptions = PushSubscription.query.filter_by(user_id=user.id).all()
    if not subscriptions:
        return 0

    sent = 0
    body = json.dumps(payload or {})
    vapid_private_key = current_app.config["VAPID_PRIVATE_KEY"]
    vapid_claims = {"sub": current_app.config.get("VAPID_CLAIMS_EMAIL", "mailto:admin@example.com")}

    for subscription in subscriptions:
        try:
            subscription_info = json.loads(subscription.subscription_json)
            webpush(
                subscription_info=subscription_info,
                data=body,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
            )
            sent += 1
        except (json.JSONDecodeError, TypeError):
            db.session.delete(subscription)
        except WebPushException as exc:
            response = getattr(exc, "response", None)
            if getattr(response, "status_code", None) in (404, 410):
                db.session.delete(subscription)
            else:
                current_app.logger.warning(
                    "Web push failed for user %s endpoint %s: %s",
                    user.id,
                    subscription.endpoint,
                    exc,
                )
        except RequestException as exc:
            current_app.logger.warning(
                "Web push network failure for user %s endpoint %s: %s",
                user.id,
                subscription.endpoint,
                exc,
            )
        except Exception as exc:  # pragma: no cover - safety net for runtime push issues
            current_app.logger.warning(
                "Unexpected web push failure for user %s endpoint %s: %s",
                user.id,
                subscription.endpoint,
                exc,
            )
    return sent
