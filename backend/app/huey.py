from huey import RedisHuey
from app import redis

huey = RedisHuey('fcp', connection_pool=redis.connection_pool)

from app.tasks import *
