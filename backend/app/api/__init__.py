from fastapi import APIRouter

public_api = APIRouter()
private_api = APIRouter()

from .auth import *  # noqa: E402, F403
from .apps import *  # noqa: E402, F403
from .frames import *  # noqa: E402, F403
from .log import *  # noqa: E402, F403
from .repositories import *  # noqa: E402, F403
from .settings import *  # noqa: E402, F403
from .ssh import *  # noqa: E402, F403
from .templates import *  # noqa: E402, F403
from .users import *  # noqa: E402, F403

