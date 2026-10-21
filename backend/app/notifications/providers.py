"""Notification providers. Add a provider by subclassing NotificationProvider and registering it.

Secrets (SMTP password, bot token, webhook signing secret) come decrypted from the channel's
`secret_enc` and are never logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import smtplib
import ssl
import time
from email.message import EmailMessage
from typing import Any, ClassVar

import aiohttp
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.config import get_settings
from app.monitoring import netguard


class DeliveryError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


class OutgoingMessage(BaseModel):
    subject: str
    body: str
    event: str
    severity: str = "info"
    incident: dict[str, Any] = Field(default_factory=dict)


class _Cfg(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmailConfig(_Cfg):
    to: list[EmailStr] = Field(min_length=1, max_length=50)
    smtp_host: str | None = None  # default: platform SMTP settings
    smtp_port: int = 587
    smtp_username: str | None = None
    starttls: bool = True
    use_ssl: bool = False
    from_address: str | None = None


class EmailSecrets(_Cfg):
    smtp_password: str | None = None


class TelegramConfig(_Cfg):
    chat_id: str = Field(min_length=1, max_length=64)
    parse_mode: str | None = None


class TelegramSecrets(_Cfg):
    bot_token: str = Field(min_length=10, max_length=100)


class WebhookConfig(_Cfg):
    url: str = Field(max_length=2048)
    method: str = "POST"
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = Field(default=10, gt=0, le=30)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        from urllib.parse import urlsplit

        p = urlsplit(v)
        if p.scheme not in ("https", "http") or not p.hostname:
            raise ValueError("webhook URL must be http(s) with a host")
        if p.username or p.password:
            raise ValueError("credentials in URLs are not allowed")
        return v

    @field_validator("method")
    @classmethod
    def _method(cls, v: str) -> str:
        if v.upper() not in ("POST", "PUT"):
            raise ValueError("method must be POST or PUT")
        return v.upper()


class WebhookSecrets(_Cfg):
    signing_secret: str | None = None  # HMAC-SHA256 signature header X-EMonitor-Signature
    headers: dict[str, str] = Field(default_factory=dict)


class InAppConfig(_Cfg):
    audience: str = "organization"  # organization | team | users
    user_ids: list[str] = Field(default_factory=list)


class NotificationProvider:
    type: ClassVar[str]
    config_model: ClassVar[type[BaseModel]]
    secrets_model: ClassVar[type[BaseModel] | None] = None

    async def send(self, config: dict[str, Any], secrets: dict[str, Any], msg: OutgoingMessage,
                   scope: netguard.Scope) -> str:
        raise NotImplementedError


class EmailProvider(NotificationProvider):
    type = "email"
    config_model = EmailConfig
    secrets_model = EmailSecrets

    async def send(self, config, secrets, msg, scope):
        cfg = EmailConfig.model_validate(config)
        s = get_settings()
        host = cfg.smtp_host or s.smtp_host
        if not host:
            raise DeliveryError("no SMTP server configured", retryable=False)
        port = cfg.smtp_port if cfg.smtp_host else s.smtp_port
        username = cfg.smtp_username if cfg.smtp_host else s.smtp_username
        password = (secrets.get("smtp_password") if cfg.smtp_host else
                    (s.smtp_password.get_secret_value() if s.smtp_password else None))
        starttls = cfg.starttls if cfg.smtp_host else s.smtp_starttls
        if cfg.smtp_host:  # user-supplied relay host must be inside the authorized scope
            try:
                await netguard.authorize(host, scope, port)
            except netguard.TargetNotAllowed as exc:
                raise DeliveryError(f"SMTP host not allowed: {exc}", retryable=False) from exc
        em = EmailMessage()
        em["Subject"] = msg.subject
        em["From"] = cfg.from_address or s.smtp_from
        em["To"] = ", ".join(cfg.to)
        em.set_content(msg.body)
        await asyncio.to_thread(_smtp_send, host, port, username, password, starttls, cfg.use_ssl, em)
        return f"accepted for {len(cfg.to)} recipient(s)"


def _smtp_send(host: str, port: int, username: str | None, password: str | None, starttls: bool, use_ssl: bool,
               message: EmailMessage) -> None:
    ctx = ssl.create_default_context()
    try:
        if use_ssl:
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20, context=ctx)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        with server:
            server.ehlo()
            if starttls and not use_ssl:
                server.starttls(context=ctx)
                server.ehlo()
            if username:
                server.login(username, password or "")
            server.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        raise DeliveryError("SMTP authentication failed", retryable=False) from exc
    except smtplib.SMTPRecipientsRefused as exc:
        raise DeliveryError("all recipients refused", retryable=False) from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise DeliveryError(f"SMTP error: {exc}") from exc


class TelegramProvider(NotificationProvider):
    type = "telegram"
    config_model = TelegramConfig
    secrets_model = TelegramSecrets
    api_base = "https://api.telegram.org"

    async def send(self, config, secrets, msg, scope):
        cfg = TelegramConfig.model_validate(config)
        token = secrets.get("bot_token")
        if not token:
            raise DeliveryError("bot token not configured", retryable=False)
        text = f"{msg.subject}\n\n{msg.body}"[:4000]
        payload: dict[str, Any] = {"chat_id": cfg.chat_id, "text": text, "disable_web_page_preview": True}
        if cfg.parse_mode:
            payload["parse_mode"] = cfg.parse_mode
        timeout = aiohttp.ClientTimeout(total=15)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f"{self.api_base}/bot{token}/sendMessage", json=payload) as resp:
                    data = await resp.json(content_type=None)
                    if resp.status == 429:
                        raise DeliveryError("Telegram rate limit")
                    if resp.status >= 500:
                        raise DeliveryError(f"Telegram server error {resp.status}")
                    if not data.get("ok"):
                        raise DeliveryError(f"Telegram rejected message: {data.get('description', resp.status)}",
                                            retryable=False)
                    return f"message_id={data.get('result', {}).get('message_id')}"
        except aiohttp.ClientError as exc:
            raise DeliveryError(f"Telegram connection error: {exc.__class__.__name__}") from exc


def sign_payload(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


class WebhookProvider(NotificationProvider):
    type = "webhook"
    config_model = WebhookConfig
    secrets_model = WebhookSecrets

    async def send(self, config, secrets, msg, scope):
        from app.monitoring.probes.http import GuardedResolver

        cfg = WebhookConfig.model_validate(config)
        body = json.dumps({
            "event": msg.event, "severity": msg.severity, "subject": msg.subject, "text": msg.body,
            "incident": msg.incident, "sent_at": int(time.time()),
        }, default=str).encode()
        headers = {"Content-Type": "application/json", "User-Agent": get_settings().probe_user_agent,
                   **cfg.headers, **(secrets.get("headers") or {})}
        if secrets.get("signing_secret"):
            ts = str(int(time.time()))
            headers["X-EMonitor-Timestamp"] = ts
            headers["X-EMonitor-Signature"] = sign_payload(secrets["signing_secret"], ts, body)
        from urllib.parse import urlsplit

        host_ip = netguard.parse_ip(urlsplit(cfg.url).hostname or "")
        if host_ip is not None:  # IP literals bypass the resolver; authorize them explicitly
            try:
                netguard.check_ip(host_ip, scope)
            except netguard.TargetNotAllowed as exc:
                raise DeliveryError(f"webhook target not allowed: {exc}", retryable=False) from exc
        state: dict[str, Any] = {}
        connector = aiohttp.TCPConnector(resolver=GuardedResolver(scope, "any", state), force_close=True,
                                         use_dns_cache=False)
        try:
            async with aiohttp.ClientSession(connector=connector,
                                             timeout=aiohttp.ClientTimeout(total=cfg.timeout_seconds)) as session:
                async with session.request(cfg.method, cfg.url, data=body, headers=headers,
                                           allow_redirects=False) as resp:
                    if 200 <= resp.status < 300:
                        return f"HTTP {resp.status}"
                    retryable = resp.status >= 500 or resp.status in (408, 429)
                    raise DeliveryError(f"webhook returned HTTP {resp.status}", retryable=retryable)
        except (TimeoutError, aiohttp.ClientError, OSError) as exc:
            if state.get("blocked"):
                raise DeliveryError(f"webhook target not allowed: {state['blocked']}", retryable=False) from exc
            raise DeliveryError(f"webhook connection error: {exc.__class__.__name__}") from exc


class InAppProvider(NotificationProvider):
    type = "in_app"
    config_model = InAppConfig

    async def send(self, config, secrets, msg, scope):  # handled synchronously by the planner
        return "stored"


PROVIDERS: dict[str, NotificationProvider] = {
    p.type: p for p in (EmailProvider(), TelegramProvider(), WebhookProvider(), InAppProvider())
}
