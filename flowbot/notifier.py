"""Telegram bildirimleri (token yoksa sadece log'a yazar)."""
import logging

import requests

log = logging.getLogger("flowbot.notify")


class Notifier:
    def __init__(self, cfg: dict):
        tg = cfg.get("telegram", {})
        self.enabled = bool(tg.get("enabled") and tg.get("token") and tg.get("chat_id"))
        self.token, self.chat_id = tg.get("token"), tg.get("chat_id")

    def send(self, text: str) -> None:
        log.info(text)
        if not self.enabled:
            return
        try:
            requests.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": self.chat_id, "text": text[:4000]},
                timeout=10,
            )
        except requests.RequestException as e:
            log.warning("Telegram gönderilemedi: %s", e)
