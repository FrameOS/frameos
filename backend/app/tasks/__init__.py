from huey.signals import SIGNAL_ERROR, SIGNAL_LOCKED

from app.huey import huey

from .deploy_frame import deploy_frame  # noqa: F401  (breaks huey)
from .reset_frame import reset_frame  # noqa: F401  (breaks huey)
from .restart_frame import restart_frame  # noqa: F401  (breaks huey)
from .stop_frame import stop_frame  # noqa: F401  (breaks huey)

@huey.signal(SIGNAL_LOCKED)
def task_not_run_handler(signal, task, exc=None):
    # Do something in response to the "ERROR" or "LOCKED" signals.
    # Note that the "ERROR" signal includes a third parameter,
    # which is the unhandled exception that was raised by the task.
    # Since this parameter is not sent with the "LOCKED" signal, we
    # provide a default of ``exc=None``.
    print('SIGNAL_ERROR')
    print(SIGNAL_ERROR)
