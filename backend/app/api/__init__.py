from fastapi import APIRouter

# When not using HASSIO_RUN_MODE (running directly from Docker):
# - api_public: routes that do not require authentication
# - api_no_auth: routes that do not require authentication
# - api_with_auth: routes that can only be accessed by authenticated users

# When using HASSIO_RUN_MODE (Home Assistant ingress with automatic login):
# - api_public: exported to the local network via port 8989, no authentication required
# - api_no_auth: accessible via Home Assistant ingress (on port 8990) without authentication
# - api_with_auth: accessible via Home Assistant ingress (on port 8990) without authentication

api_public = APIRouter()
api_no_auth = APIRouter()
api_with_auth = APIRouter()

from .auth import *  # noqa: E402, F403
from .apps import *  # noqa: E402, F403
from .frames import *  # noqa: E402, F403
from .log import *  # noqa: E402, F403
from .repositories import *  # noqa: E402, F403
from .settings import *  # noqa: E402, F403
from .ssh import *  # noqa: E402, F403
from .templates import *  # noqa: E402, F403
from .users import *  # noqa: E402, F403

