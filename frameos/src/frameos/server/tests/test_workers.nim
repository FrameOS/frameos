import unittest

import ../workers

suite "Server worker threads":
  test "caps mummy workers for constrained frame devices":
    check httpWorkerThreads(0) == 1
    check httpWorkerThreads(1) == 1
    check httpWorkerThreads(2) == 2
    check httpWorkerThreads(4) == 4
    check httpWorkerThreads(8) == 4
