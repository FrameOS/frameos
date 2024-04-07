from flask import Blueprint

api = Blueprint('api', __name__)

from .apps import *
from .frames import *
from .log import *
from .login import *
from .repositories import *
from .settings import *
from .templates import *
from .misc import *
from .sock import *
