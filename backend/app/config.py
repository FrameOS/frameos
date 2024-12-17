import os
import secrets

def get_bool_env(key: str) -> bool:
    return os.environ.get(key, '0').lower() in ['true', '1', 'yes']

class Config:
    DEBUG = get_bool_env('DEBUG')
    TEST = get_bool_env('TEST')
    SECRET_KEY = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
    DATABASE_URL = os.environ.get('DATABASE_URL') or 'sqlite:///../db/frameos.db'
    REDIS_URL = os.environ.get('REDIS_URL') or 'redis://localhost:6379/0'

class DevelopmentConfig(Config):
    DEBUG = True

class TestConfig(Config):
    TEST = True
    DATABASE_URL = 'sqlite:///:memory:'

class ProductionConfig(Config):
    pass

configs = {
    "development": DevelopmentConfig,
    "testing": TestConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig
}

def get_config() -> Config:
    is_test = get_bool_env('TEST')
    is_dev = get_bool_env('DEBUG')
    config_class = TestConfig if is_test else DevelopmentConfig if is_dev else ProductionConfig
    return config_class()
