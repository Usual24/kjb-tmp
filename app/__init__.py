"""Application factory for KJB chat community."""
from flask import Flask
from sqlalchemy import inspect, text
from .extensions import db, migrate, socketio
from .routes import views
from .sockets import register_socket_handlers
from .utils import init_session, get_current_user, media_url, resolve_channel_permissions
from .models import Channel, Notification


def create_app(config_object="config.Config"):
    app = Flask(__name__)
    app.config.from_object(config_object)

    db.init_app(app)
    migrate.init_app(app, db)
    socketio.init_app(app)
    init_session(app)

    app.register_blueprint(views.bp)

    @app.context_processor
    def inject_globals():
        current_user = get_current_user()
        channels = Channel.query.order_by(Channel.priority.desc(), Channel.name.asc()).all()
        has_unread_notifications = False
        if current_user and not current_user.is_admin:
            channels = [
                channel
                for channel in channels
                if resolve_channel_permissions(current_user, channel)["can_view"]
            ]
        if current_user:
            has_unread_notifications = (
                Notification.query.filter_by(user_id=current_user.id, is_read=False).first()
                is not None
            )
        return {
            "current_user": current_user,
            "channels": channels,
            "has_unread_notifications": has_unread_notifications,
            "vapid_public_key": app.config.get("VAPID_PUBLIC_KEY", ""),
        }

    @app.template_filter("media")
    def media_filter(value):
        return media_url(value)

    with app.app_context():
        db.create_all()
        inspector = inspect(db.engine)
        emoji_columns = {column["name"] for column in inspector.get_columns("emojis")}
        if "is_public" not in emoji_columns:
            db.session.execute(
                text("ALTER TABLE emojis ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT 0")
            )
            db.session.commit()
        notification_columns = {column["name"] for column in inspector.get_columns("notifications")}
        if "link_url" not in notification_columns:
            db.session.execute(text("ALTER TABLE notifications ADD COLUMN link_url VARCHAR(255)"))
            db.session.commit()
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        if "browser_notifications_enabled" not in user_columns:
            db.session.execute(
                text("ALTER TABLE users ADD COLUMN browser_notifications_enabled BOOLEAN NOT NULL DEFAULT 0")
            )
            db.session.commit()
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "client_message_id" not in message_columns:
            db.session.execute(text("ALTER TABLE messages ADD COLUMN client_message_id VARCHAR(80)"))
            db.session.commit()
        duplicate_message_keys = db.session.execute(
            text(
                """
                SELECT user_id, client_message_id
                FROM messages
                WHERE client_message_id IS NOT NULL
                GROUP BY user_id, client_message_id
                HAVING COUNT(*) > 1
                LIMIT 1
                """
            )
        ).first()
        if not duplicate_message_keys:
            db.session.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_user_client_message_id "
                    "ON messages (user_id, client_message_id)"
                )
            )
            db.session.commit()
        else:
            app.logger.warning(
                "Skipping unique index on messages(user_id, client_message_id) because duplicate rows already exist."
            )
        if "image_url" not in message_columns:
            db.session.execute(text("ALTER TABLE messages ADD COLUMN image_url VARCHAR(255)"))
            db.session.commit()
        if "attachment_url" not in message_columns:
            db.session.execute(text("ALTER TABLE messages ADD COLUMN attachment_url VARCHAR(255)"))
            db.session.commit()
        if "attachment_name" not in message_columns:
            db.session.execute(text("ALTER TABLE messages ADD COLUMN attachment_name VARCHAR(255)"))
            db.session.commit()
        if "attachment_mime" not in message_columns:
            db.session.execute(text("ALTER TABLE messages ADD COLUMN attachment_mime VARCHAR(120)"))
            db.session.commit()
        if not Channel.query.first():
            db.session.add(Channel(slug="general", name="# general", description="기본 채널"))
            db.session.commit()

    register_socket_handlers(socketio, app)

    return app
