from redis.asyncio import from_url as create_redis
from app.config import get_config

def create_redis_connection():
    return create_redis(get_config().REDIS_URL)

async def get_redis():
    redis = create_redis_connection()
    try:
        yield redis
    finally:
        await redis.close()
