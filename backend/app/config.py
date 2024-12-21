import os
import secrets
from dotenv import load_dotenv

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

class Config:
    DEBUG = get_bool_env('DEBUG')
    TEST = get_bool_env('TEST')
    SECRET_KEY = os.environ.get('SECRET_KEY')
    DATABASE_URL = os.environ.get('DATABASE_URL') or 'sqlite:///../db/frameos.db'
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/0'

class DevelopmentConfig(Config):
    DEBUG = True
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
            self.SECRET_KEY = secrets.token_urlsafe(32)

class TestConfig(Config):
    TEST = True
    DATABASE_URL = 'sqlite:///:memory:?check_same_thread=False'
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
            self.SECRET_KEY = secrets.token_urlsafe(32)

class ProductionConfig(Config):
    def __init__(self):
        super().__init__()
        if self.SECRET_KEY is None:
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
