import os
import yaml
from dotenv import load_dotenv


def load_config(path: str = "config.yaml") -> dict:
    """YAML ayarlarını okur, gizli anahtarları .env / ortam değişkenlerinden ekler."""
    load_dotenv()
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    ex = cfg.setdefault("exchange", {})
    ex["api_key"] = os.getenv("EXCHANGE_API_KEY", "")
    ex["api_secret"] = os.getenv("EXCHANGE_API_SECRET", "")
    ex["password"] = os.getenv("EXCHANGE_PASSWORD", "")

    tg = cfg.setdefault("telegram", {})
    tg["token"] = os.getenv("TELEGRAM_TOKEN", "")
    tg["chat_id"] = os.getenv("TELEGRAM_CHAT_ID", "")
    return cfg
