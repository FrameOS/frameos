from fastapi import APIRouter

public_api = APIRouter()
private_api = APIRouter()

from .auth import *
from .apps import *
from .frames import *
from .log import *
from .repositories import *
from .settings import *
from .ssh import *
from .templates import *
from .users import *

