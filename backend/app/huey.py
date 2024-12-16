from huey import RedisHuey
from app.redis import redis

huey = RedisHuey('fcp', connection_pool=redis.connection_pool)

from app.tasks import *  # noqa: E402, F403
