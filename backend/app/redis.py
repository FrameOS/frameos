from arq import ArqRedis
from arq.connections import ConnectionPool
from app.config import get_config

def create_redis_connection():
    pool = ConnectionPool.from_url(get_config().REDIS_URL)
    return ArqRedis(pool)

async def get_redis():
    redis = create_redis_connection()
    try:
        yield redis
    finally:
        await redis.close()
