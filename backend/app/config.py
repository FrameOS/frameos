import os
import secrets
import uuid
from dotenv import load_dotenv
import requests

def get_bool_env(key: str) -> bool:
    return os.environ.get(key, '0').lower() in ['true', '1', 'yes']

# If in development mode, load .env variables as fallback
if get_bool_env('DEBUG'):
    load_dotenv(override=False)

    if not os.environ.get('SECRET_KEY'):
        secret = secrets.token_hex(32)
        with open('.env', 'a') as f:
            f.write(f'# Development environment variables. Don\'t commit.\nSECRET_KEY={secret}')
        os.environ['SECRET_KEY'] = secret


INSTANCE_ID = str(uuid.uuid4())

class Config:
    DEBUG = get_bool_env('DEBUG')
    TEST = get_bool_env('TEST')
    SECRET_KEY = os.environ.get('SECRET_KEY')
    DATABASE_URL = os.environ.get('DATABASE_URL') or 'sqlite:///../db/frameos.db'
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/0'
    INSTANCE_ID = INSTANCE_ID
    HASSIO_RUN_MODE = os.environ.get('HASSIO_RUN_MODE', None)
    HASSIO_TOKEN = os.environ.get('HASSIO_TOKEN', None)
    SUPERVISOR_TOKEN = os.environ.get('SUPERVISOR_TOKEN', None)
    ingress_path = ''

    def __init__(self):
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
                if ingress_url and ingress_url.endswith("/"):
                    ingress_url = ingress_url[:-1]
                self.ingress_path = ingress_url
                print(f"🟢 Fetched HA ingress URL: {self.ingress_path}")
            except Exception as e:
                print(f"🔴 Failed to get HA ingress URL: {e}")

class DevelopmentConfig(Config):
    DEBUG = True
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
            self.SECRET_KEY = secrets.token_urlsafe(32)

class TestConfig(Config):
    TEST = True
    DATABASE_URL = "sqlite:///migrations/test.db"
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/1'
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
            self.SECRET_KEY = secrets.token_urlsafe(32)

class ProductionConfig(Config):
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
            if self.HASSIO_RUN_MODE is not None:
                self.SECRET_KEY = secrets.token_urlsafe(32)
            else:
                raise ValueError('SECRET_KEY must be set in production')

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
