from urllib.parse import urlparse
from redis import Redis
from app.config import get_config

# Redis setup
def create_redis_connection():
    parsed_url = urlparse(get_config().REDIS_URL)
    redis_host = parsed_url.hostname
    redis_port = parsed_url.port or 6379
    return Redis(host=redis_host, port=redis_port)

redis = create_redis_connection()
