import os
import secrets
from typing import cast


class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
    SQLALCHEMY_DATABASE_URI = 'sqlite:///../../db/frameos.db'

class DevelopmentConfig(Config):
    DEBUG = True

class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = 'sqlite:///:memory:'
    WTF_CSRF_ENABLED = False

class ProductionConfig(Config):
    pass

configs = {
    "development": DevelopmentConfig,
    "testing": TestConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig
}

def get_config() -> Config:
    config_name = os.getenv('FLASK_CONFIG') or 'default'
    config_class = configs.get(config_name)
    return config_class or cast(Config, configs['default'])
