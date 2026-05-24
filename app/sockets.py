from datetime import datetime, timedelta
import re
from threading import RLock, Timer

from flask import session
from flask_socketio import emit, join_room, leave_room
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import joinedload

from .extensions import db
from .models import (
    Channel,
    Emoji,
    Message,
    Notification,
    User,
    UserAccessoryPermission,
    UserChannelRead,
    UserEmojiPermission,
)
from .utils import media_url, render_chat_content, resolve_channel_permissions, to_kst
from .push import send_web_push

online_users = set()
channel_typing_users = {}
connected_user_profiles = {}
pending_online_timers = {}
pending_typing_timers = {}
presence_lock = RLock()
public_emoji_cache = {"expires_at": None, "map": {}}
MENTION_PATTERN = re.compile(r"(?<!\w)@([a-zA-Z0-9._\-]+)")


def _current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return User.query.get(user_id)


def _mark_channel_read(user_id, channel_id, message_id):
    if not user_id or not channel_id or not message_id:
        return
    state = UserChannelRead.query.filter_by(user_id=user_id, channel_id=channel_id).first()
    if not state:
        db.session.add(
            UserChannelRead(user_id=user_id, channel_id=channel_id, last_read_message_id=message_id)
        )
        return
    if state.last_read_message_id < message_id:
        state.last_read_message_id = message_id


def _emit_typing_update(channel_slug):
    user_ids = list(channel_typing_users.get(channel_slug, set()))
    users = [connected_user_profiles[user_id] for user_id in user_ids if user_id in connected_user_profiles]
    emit(
        "typing_update",
        {"channel": channel_slug, "users": users},
        room=channel_slug,
    )


def _cancel_timer(timer_map, key):
    timer = timer_map.pop(key, None)
    if timer:
        timer.cancel()


def _schedule_timer(timer_map, key, delay, callback):
    _cancel_timer(timer_map, key)
    timer = Timer(delay, callback)
    timer.daemon = True
    timer_map[key] = timer
    timer.start()
    return timer


def _public_emoji_map():
    now = datetime.utcnow()
    expires_at = public_emoji_cache["expires_at"]
    if expires_at and expires_at > now:
        return public_emoji_cache["map"]
    public_emojis = Emoji.query.filter_by(is_public=True).all()
    emoji_map = {emoji.name: emoji.image_url for emoji in public_emojis}
    public_emoji_cache["map"] = emoji_map
    public_emoji_cache["expires_at"] = now.replace(microsecond=0) + timedelta(seconds=30)
    return emoji_map


def _active_accessory_map(user_ids):
    if not user_ids:
        return {}
    permissions = (
        UserAccessoryPermission.query.options(joinedload(UserAccessoryPermission.accessory))
        .filter(
            UserAccessoryPermission.user_id.in_(user_ids),
            UserAccessoryPermission.is_active.is_(True),
        )
        .order_by(UserAccessoryPermission.user_id.asc(), UserAccessoryPermission.created_at.desc())
        .all()
    )
    result = {}
    for permission in permissions:
        if permission.user_id not in result:
            result[permission.user_id] = permission
    return result


def _emoji_scope_map(messages):
    base_emoji_map = _public_emoji_map()
    user_ids = {message.user_id for message in messages}
    if not user_ids:
        return base_emoji_map, {}
    users = User.query.options(
        joinedload(User.emoji_permissions).joinedload(UserEmojiPermission.emoji)
    ).filter(User.id.in_(user_ids))
    per_user_map = {}
    for user in users:
        scoped = dict(base_emoji_map)
        scoped.update(
            {
                permission.emoji.name: permission.emoji.image_url
                for permission in user.emoji_permissions
                if permission.emoji
            }
        )
        per_user_map[user.id] = scoped
    return base_emoji_map, per_user_map


def _serialize_message_with_context(message, emoji_map, active_accessory):
    created_at = to_kst(message.created_at)
    updated_at = to_kst(message.updated_at) if message.updated_at else None
    return {
        "id": message.id,
        "channel_id": message.channel_id,
        "user_id": message.user_id,
        "client_message_id": message.client_message_id,
        "user_name": message.user.name,
        "user_prefix": message.user.email_prefix,
        "avatar": media_url(message.user.avatar_url),
        "content": message.content,
        "attachment_url": media_url(message.attachment_url or message.image_url)
        if (message.attachment_url or message.image_url)
        else None,
        "attachment_name": message.attachment_name,
        "attachment_mime": message.attachment_mime,
        "image_url": (
            media_url(message.attachment_url or message.image_url)
            if (message.attachment_url or message.image_url)
            and ((message.attachment_mime or "").startswith("image/") or message.image_url)
            else None
        ),
        "rendered_content": str(render_chat_content(message.content, emoji_map)),
        "reply_to": (
            message.reply_to.content
            if message.reply_to and message.reply_to.content
            else "[사진]"
            if message.reply_to and (
                (message.reply_to.attachment_mime or "").startswith("image/")
                or (message.reply_to.image_url and not message.reply_to.attachment_url)
            )
            else "[파일]"
            if message.reply_to and (message.reply_to.attachment_url or message.reply_to.image_url)
            else None
        ),
        "reply_to_id": message.reply_to_id,
        "is_deleted": message.is_deleted,
        "name_color": (
            active_accessory.accessory.text_color if active_accessory and active_accessory.accessory else None
        ),
        "accessory_image": (
            media_url(active_accessory.accessory.image_url)
            if active_accessory and active_accessory.accessory
            else None
        ),
        "created_at": created_at.strftime("%Y-%m-%d %H:%M"),
        "updated_at": updated_at.strftime("%Y-%m-%d %H:%M") if updated_at else None,
    }


def serialize_messages(messages):
    if not messages:
        return []
    user_ids = {message.user_id for message in messages}
    accessory_map = _active_accessory_map(user_ids)
    base_emoji_map, per_user_emoji = _emoji_scope_map(messages)
    return [
        _serialize_message_with_context(
            message,
            per_user_emoji.get(message.user_id, base_emoji_map),
            accessory_map.get(message.user_id),
        )
        for message in messages
    ]


def serialize_message(message):
    return serialize_messages([message])[0]


def _notify_mentions(socketio, sender, channel_slug, message_id, content):
    if not sender or not content:
        return
    prefixes = {match.group(1).lower() for match in MENTION_PATTERN.finditer(content)}
    if not prefixes:
        return
    targets = User.query.filter(User.email_prefix.in_(prefixes)).all()
    for target in targets:
        payload = {
            "title": "멘션",
            "body": f"{sender.name}님이 회원님을 멘션했습니다.",
            "link_url": f"/chat?id={channel_slug}#message-{message_id}",
        }
        db.session.add(
            Notification(
                user_id=target.id,
                title=payload["title"],
                body=payload["body"],
                link_url=payload["link_url"],
            )
        )
        sent = send_web_push(target, payload)
        if sent == 0:
            socketio.emit("browser_notification", payload, room=f"user_{target.id}")


def _compute_unread_channel_ids(user):
    if not user:
        return set()
    channel_ids = [channel.id for channel in Channel.query.all()]
    if not channel_ids:
        return set()
    latest_rows = (
        db.session.query(Message.channel_id, db.func.max(Message.id))
        .filter(Message.channel_id.in_(channel_ids), Message.is_deleted.is_(False))
        .group_by(Message.channel_id)
        .all()
    )
    latest_map = {channel_id: max_id for channel_id, max_id in latest_rows if max_id}
    read_rows = UserChannelRead.query.filter(
        UserChannelRead.user_id == user.id,
        UserChannelRead.channel_id.in_(channel_ids),
    ).all()
    read_map = {row.channel_id: row.last_read_message_id for row in read_rows}
    return {
        channel_id
        for channel_id, max_id in latest_map.items()
        if (read_map.get(channel_id) or 0) < max_id
    }



def register_socket_handlers(socketio, app):

    def emit_presence_update():
        with app.app_context():
            socketio.emit("online_update", _online_payload())

    def emit_sync_snapshot(user):
        with app.app_context():
            socketio.emit(
                "sync_snapshot",
                {"unread_channel_ids": sorted(_compute_unread_channel_ids(user))},
                room=f"user_{user.id}",
            )

    def schedule_offline(user_id):
        def _run():
            with presence_lock:
                if user_id in online_users:
                    online_users.discard(user_id)
                    connected_user_profiles.pop(user_id, None)
                pending_online_timers.pop(user_id, None)
            emit_presence_update()

        with presence_lock:
            _schedule_timer(pending_online_timers, user_id, 1.2, _run)

    def cancel_offline(user_id):
        with presence_lock:
            _cancel_timer(pending_online_timers, user_id)

    def schedule_typing_offline(user_id, channel_slug):
        key = (user_id, channel_slug)

        def _run():
            with presence_lock:
                typers = channel_typing_users.get(channel_slug, set())
                if user_id in typers:
                    typers.discard(user_id)
                    if not typers:
                        channel_typing_users.pop(channel_slug, None)
                pending_typing_timers.pop(key, None)
                user_ids = list(channel_typing_users.get(channel_slug, set()))
                users = [
                    connected_user_profiles[uid]
                    for uid in user_ids
                    if uid in connected_user_profiles
                ]
            with app.app_context():
                socketio.emit(
                    "typing_update",
                    {"channel": channel_slug, "users": users},
                    room=channel_slug,
                )

        with presence_lock:
            _schedule_timer(pending_typing_timers, key, 1.5, _run)

    def cancel_typing_offline(user_id, channel_slug):
        with presence_lock:
            _cancel_timer(pending_typing_timers, (user_id, channel_slug))

    @socketio.on("connect")
    def handle_connect(auth=None):
        user = _current_user()
        if not user:
            return False
        with presence_lock:
            cancel_offline(user.id)
            online_users.add(user.id)
            connected_user_profiles[user.id] = {
                "id": user.id,
                "name": user.name,
                "browser_notifications_enabled": user.browser_notifications_enabled,
            }
        join_room(f"user_{user.id}")
        socketio.emit("online_update", _online_payload())
        emit_sync_snapshot(user)

    @socketio.on("disconnect")
    def handle_disconnect():
        user = _current_user()
        if user:
            schedule_offline(user.id)
            for channel_slug in list(channel_typing_users.keys()):
                typers = channel_typing_users.get(channel_slug, set())
                if user.id in typers:
                    schedule_typing_offline(user.id, channel_slug)

    @socketio.on("join")
    def handle_join(data):
        user = _current_user()
        if not user:
            return
        channel_slug = data.get("channel")
        if not channel_slug:
            return
        channel = Channel.query.filter_by(slug=channel_slug).first()
        if not channel:
            return
        if not resolve_channel_permissions(user, channel)["can_view"]:
            return
        join_room(channel_slug)

    @socketio.on("leave")
    def handle_leave(data):
        user = _current_user()
        channel_slug = data.get("channel")
        if not channel_slug:
            return
        leave_room(channel_slug)
        if user:
            cancel_typing_offline(user.id, channel_slug)
            typers = channel_typing_users.get(channel_slug, set())
            if user.id in typers:
                typers.discard(user.id)
                if not typers:
                    channel_typing_users.pop(channel_slug, None)
                _emit_typing_update(channel_slug)

    @socketio.on("send_message")
    def handle_send_message(data):
        user = _current_user()
        if not user:
            return {"ok": False, "error": "unauthorized"}

        channel_slug = data.get("channel")
        content = (data.get("content") or "").strip()
        attachment_url = (data.get("attachment_url") or data.get("image_url") or "").strip()
        attachment_name = (data.get("attachment_name") or "").strip()
        attachment_mime = (data.get("attachment_mime") or "").strip()
        reply_to_id = data.get("reply_to")
        client_message_id = (data.get("client_message_id") or "").strip()
        if not channel_slug or (not content and not attachment_url):
            return {"ok": False, "error": "invalid_request"}

        channel = Channel.query.filter_by(slug=channel_slug).first()
        if not channel:
            return {"ok": False, "error": "channel_not_found"}
        if not resolve_channel_permissions(user, channel)["can_send"]:
            return {"ok": False, "error": "permission_denied"}

        if reply_to_id:
            try:
                reply_to_id = int(reply_to_id)
            except (TypeError, ValueError):
                reply_to_id = None
        else:
            reply_to_id = None

        if client_message_id:
            existing = Message.query.filter_by(
                user_id=user.id,
                client_message_id=client_message_id,
            ).first()
            if existing:
                payload = serialize_message(existing)
                return {"ok": True, "message_id": existing.id, "message": payload, "deduped": True}

        message = Message(
            channel_id=channel.id,
            user_id=user.id,
            client_message_id=client_message_id or None,
            content=content,
            attachment_url=attachment_url or None,
            attachment_name=attachment_name or None,
            attachment_mime=attachment_mime or None,
            image_url=attachment_url if (attachment_mime or "").startswith("image/") else None,
            reply_to_id=reply_to_id,
        )
        try:
            db.session.add(message)
            db.session.flush()
            _mark_channel_read(user.id, channel.id, message.id)
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            if client_message_id:
                existing = Message.query.filter_by(
                    user_id=user.id,
                    client_message_id=client_message_id,
                ).first()
                if existing:
                    payload = serialize_message(existing)
                    emit("new_message", payload, room=channel_slug)
                    return {
                        "ok": True,
                        "message_id": existing.id,
                        "message": payload,
                        "deduped": True,
                    }
            return {"ok": False, "error": "duplicate_message"}

        payload = serialize_message(message)
        emit("new_message", payload, room=channel_slug)

        def _notify_mentions_task(sender_id, channel_slug_value, message_id, message_content):
            with app.app_context():
                sender = User.query.get(sender_id)
                try:
                    _notify_mentions(socketio, sender, channel_slug_value, message_id, message_content)
                    db.session.commit()
                except Exception:
                    db.session.rollback()
                    app.logger.exception("Failed to dispatch mention notifications for message %s", message_id)

        if content:
            socketio.start_background_task(
                _notify_mentions_task,
                user.id,
                channel.slug,
                message.id,
                content,
            )

        return {"ok": True, "message_id": message.id, "message": payload}

    @socketio.on("typing")
    def handle_typing(data):
        user = _current_user()
        if not user:
            return
        channel_slug = data.get("channel")
        is_typing = bool(data.get("is_typing"))
        if not channel_slug:
            return
        channel = Channel.query.filter_by(slug=channel_slug).first()
        if not channel:
            return
        if not resolve_channel_permissions(user, channel)["can_view"]:
            return
        cancel_typing_offline(user.id, channel_slug)
        typers = channel_typing_users.setdefault(channel_slug, set())
        if is_typing:
            typers.add(user.id)
        else:
            typers.discard(user.id)
        if not typers:
            channel_typing_users.pop(channel_slug, None)
        _emit_typing_update(channel_slug)

    @socketio.on("sync_channel")
    def handle_sync_channel(data):
        user = _current_user()
        if not user:
            return {"ok": False, "error": "unauthorized"}
        channel_slug = data.get("channel")
        after_message_id = data.get("after_message_id")
        try:
            after_message_id = int(after_message_id or 0)
        except (TypeError, ValueError):
            after_message_id = 0
        if not channel_slug:
            return {"ok": False, "error": "invalid_request"}
        channel = Channel.query.filter_by(slug=channel_slug).first()
        if not channel:
            return {"ok": False, "error": "channel_not_found"}
        permissions = resolve_channel_permissions(user, channel)
        if not permissions["can_view"]:
            return {"ok": False, "error": "permission_denied"}

        messages = (
            Message.query.options(
                joinedload(Message.user),
                joinedload(Message.reply_to),
            )
            .filter(
                Message.channel_id == channel.id,
                Message.id > after_message_id,
                Message.is_deleted.is_(False),
            )
            .order_by(Message.id.asc())
            .limit(200)
            .all()
        )
        return {
            "ok": True,
            "messages": serialize_messages(messages),
            "unread_channel_ids": sorted(_compute_unread_channel_ids(user)),
        }

    @socketio.on("edit_message")
    def handle_edit_message(data):
        user = _current_user()
        if not user:
            return
        message_id = data.get("message_id")
        content = (data.get("content") or "").strip()
        if not message_id or not content:
            return
        message = Message.query.get(message_id)
        if not message or message.is_deleted:
            return
        if message.user_id != user.id:
            return
        message.content = content
        message.updated_at = datetime.utcnow()
        db.session.commit()
        emit("message_updated", serialize_message(message), room=_channel_slug(message))

    @socketio.on("delete_message")
    def handle_delete_message(data):
        user = _current_user()
        if not user:
            return
        message_id = data.get("message_id")
        message = Message.query.get(message_id)
        if not message:
            return
        if message.user_id != user.id and not user.is_admin:
            return
        db.session.query(Message).filter(Message.reply_to_id == message.id).update(
            {Message.reply_to_id: None},
            synchronize_session=False,
        )
        db.session.delete(message)
        db.session.commit()
        emit("message_deleted", {"message_id": message.id}, room=_channel_slug(message))


def _online_payload():
    users = User.query.order_by(User.name.asc(), User.email_prefix.asc()).all()
    accessory_map = _active_accessory_map({user.id for user in users})
    online = []
    offline = []
    for user in users:
        active_accessory = accessory_map.get(user.id)
        payload = {
            "id": user.id,
            "name": user.name,
            "email_prefix": user.email_prefix,
            "avatar": media_url(user.avatar_url),
            "is_online": user.id in online_users,
            "name_color": (
                active_accessory.accessory.text_color
                if active_accessory and active_accessory.accessory
                else None
            ),
            "accessory_image": (
                media_url(active_accessory.accessory.image_url)
                if active_accessory and active_accessory.accessory
                else None
            ),
        }
        (online if payload["is_online"] else offline).append(payload)
    return {"online": online, "offline": offline}


def _channel_slug(message):
    channel = Channel.query.get(message.channel_id)
    return channel.slug if channel else "general"
