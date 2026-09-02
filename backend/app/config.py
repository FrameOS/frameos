import os
import secrets
import uuid
from urllib.parse import urlparse
from dotenv import load_dotenv
import requests

def get_bool_env(key: str) -> bool:
    return os.environ.get(key, '0').lower() in ['true', '1', 'yes']

# If in development mode, load .env variables as fallback
if get_bool_env('DEBUG'):
    load_dotenv(override=False)

    if not os.environ.get('SECRET_KEY'):
        secret = secrets.token_urlsafe(32)
        with open('.env', 'a') as f:
            f.write(f'# Development environment variables. Don\'t commit this file.\nSECRET_KEY={secret}')
        os.environ['SECRET_KEY'] = secret


INSTANCE_ID = str(uuid.uuid4())

DEFAULT_DATABASE_URL = 'sqlite:///../db/frameos.db'


def secret_key_file_path() -> str:
    """Where a generated SECRET_KEY is persisted when none is configured:
    next to the sqlite database (the docker-compose volume), or /data on a
    Home Assistant add-on. Override with SECRET_KEY_FILE."""
    explicit = os.environ.get('SECRET_KEY_FILE')
    if explicit:
        return explicit
    if os.environ.get('HASSIO_TOKEN') and os.path.isdir('/data'):
        return '/data/secret_key'
    database_url = os.environ.get('DATABASE_URL') or DEFAULT_DATABASE_URL
    if database_url.startswith('sqlite:///'):
        db_path = database_url[len('sqlite:///'):].split('?', 1)[0]
        return os.path.join(os.path.dirname(db_path) or '.', 'secret_key')
    return os.path.join('..', 'db', 'secret_key')


def resolve_secret_key(path: str | None = None) -> tuple[str, str]:
    """``(key, source)`` with source ``env``, ``file`` or ``generated``.

    Without SECRET_KEY in the environment the key is generated once and kept
    in ``path`` (mode 0600), so the web and worker processes of one install
    share it across restarts: each picking its own key meant the worker could
    never decrypt what the web process stored (cloud link tokens, sessions).
    """
    from_env = os.environ.get('SECRET_KEY')
    if from_env:
        return from_env, 'env'

    path = path or secret_key_file_path()
    try:
        with open(path) as f:
            stored = f.read().strip()
        if stored:
            return stored, 'file'
    except OSError:
        pass

    generated = secrets.token_urlsafe(32)
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # Another process (web vs worker) won the race; use what it wrote.
            with open(path) as f:
                stored = f.read().strip()
            return (stored, 'file') if stored else (generated, 'generated')
        with os.fdopen(fd, 'w') as f:
            f.write(generated + '\n')
    except OSError as e:
        print(
            f"🔴 Could not persist SECRET_KEY to {path}: {e}. Using a per-process key; "
            "sessions and encrypted secrets will not survive a restart."
        )
    return generated, 'generated'

def normalize_ingress_path(value: str | None) -> str:
    if not value:
        return ""

    path = str(value).strip()
    if "://" in path:
        path = urlparse(path).path

    path = path.strip()
    if not path:
        return ""
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return path

class Config:
    DEBUG = get_bool_env('DEBUG')
    TEST = get_bool_env('TEST')
    # Resolved in __init__ (resolve_secret_key), never at class definition.
    SECRET_KEY: str = ''
    SECRET_KEY_SOURCE: str = 'env'
    # Cloud link secrets are encrypted with CLOUD_SECRET_KEY when set, else
    # SECRET_KEY. Set it to decouple them, so SECRET_KEY can be rotated without
    # killing the cloud link. PREVIOUS_SECRET_KEYS (comma separated) are tried
    # on decrypt only; stored secrets are re-encrypted with the current key as
    # they are read, so old keys can be dropped after a sync cycle.
    # See docs/cloud-link.md.
    CLOUD_SECRET_KEY = os.environ.get('CLOUD_SECRET_KEY') or ''
    PREVIOUS_SECRET_KEYS = [
        key.strip() for key in (os.environ.get('PREVIOUS_SECRET_KEYS') or '').split(',') if key.strip()
    ]
    DATABASE_URL = os.environ.get('DATABASE_URL') or DEFAULT_DATABASE_URL
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/0'
    INSTANCE_ID = INSTANCE_ID
    # FrameOS Cloud provider origin. Empty = https://cloud.frameos.net,
    # any http(s) URL = a compatible self-hosted provider, 'disabled' = hide
    # the cloud link entirely. See docs/cloud-link.md.
    FRAMEOS_CLOUD_URL = os.environ.get('FRAMEOS_CLOUD_URL') or os.environ.get('FRAMEOS_AUTH_PROVIDER_URL') or ''
    # The origin this install is reached at, e.g. https://frameos.example. Set
    # this when a reverse proxy fronts FrameOS: it governs the cloud login
    # redirect_uri and the logout return_to, and without it those are derived
    # from request headers the caller controls. See docs/cloud-link.md.
    FRAMEOS_PUBLIC_URL = os.environ.get('FRAMEOS_PUBLIC_URL') or ''
    # Comma-separated proxy addresses whose X-Forwarded-* headers may be
    # trusted. Empty = trust loopback and private-range peers only, which
    # covers the usual docker/reverse-proxy setups without letting a client
    # off the local network claim any origin it likes.
    FRAMEOS_TRUSTED_PROXIES = os.environ.get('FRAMEOS_TRUSTED_PROXIES') or ''
    HASSIO_RUN_MODE = os.environ.get('HASSIO_RUN_MODE', None)
    HASSIO_TOKEN = os.environ.get('HASSIO_TOKEN', None)
    SUPERVISOR_TOKEN = os.environ.get('SUPERVISOR_TOKEN', None)
    ingress_path = ''

    def load_secret_key(self) -> tuple[str, str]:
        return resolve_secret_key()

    def __init__(self):
        self.SECRET_KEY, self.SECRET_KEY_SOURCE = self.load_secret_key()
        # Get Home Assistant Supervisor Ingress URL
        if self.HASSIO_RUN_MODE == "ingress" and self.SUPERVISOR_TOKEN:
            try:
                headers = {
                    "Authorization": f"Bearer {self.SUPERVISOR_TOKEN}",
                    "Content-Type": "application/json",
                }
                response = requests.get("http://supervisor/addons/self/info", headers=headers)
                info = response.json()
                ingress_url = info.get("data", {}).get("ingress_url")
                self.ingress_path = normalize_ingress_path(ingress_url)
                print(f"🟢 Fetched HA ingress URL: {self.ingress_path}")
            except Exception as e:
                print(f"🔴 Failed to get HA ingress URL: {e}")

class DevelopmentConfig(Config):
    DEBUG = True

class TestConfig(Config):
    TEST = True
    DATABASE_URL = os.environ.get('DATABASE_URL') or "sqlite:///migrations/test.db"
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/1'
    def load_secret_key(self) -> tuple[str, str]:
        # Tests never touch the persisted key file.
        from_env = os.environ.get('SECRET_KEY')
        return (from_env, 'env') if from_env else (secrets.token_urlsafe(32), 'generated')

class ProductionConfig(Config):
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY_SOURCE != 'env':
            # Not fatal: existing installs (docker compose, the HA add-on) run
            # without SECRET_KEY and must keep booting. The persisted key is
            # what makes that safe across processes and restarts.
            print(
                "🟡 SECRET_KEY is not set; using the generated key in "
                f"{secret_key_file_path()}. Set SECRET_KEY in the environment for production installs."
            )

configs = {
    "development": DevelopmentConfig,
    "testing": TestConfig,
    "production": ProductionConfig,
    "default": ProductionConfig,
}

def get_config() -> Config:
    is_test = get_bool_env('TEST')
    is_dev = get_bool_env('DEBUG')
    config_class = TestConfig if is_test else DevelopmentConfig if is_dev else ProductionConfig
    return config_class()

# Singleton instance
config = get_config()
