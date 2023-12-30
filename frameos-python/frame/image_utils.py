from typing import Optional

from PIL import Image
import numpy as np
import struct
import fcntl
import subprocess

from apps import ExecutionContext
from .logger import Logger


def rgb_to_eink_images(rgb_img: Image, red_threshold=(100, 50, 50)):
    pixels = list(rgb_img.getdata())

    black = []
    red = []

    # Loop through the original pixels
    for pixel in pixels:
        r, g, b = pixel
        gray_value = int(0.2989 * r + 0.5870 * g + 0.1140 * b)

        if r > red_threshold[0] and g > red_threshold[1] and b > red_threshold[2]:
            red.append(gray_value)
            black.append(255)
        else:
            black.append(gray_value)
            red.append(255)

    red_img = Image.new('L', rgb_img.size, 255)
    red_img.putdata(red)

    black_img = Image.new('L', rgb_img.size, 255)
    black_img.putdata(black)

    return black_img, red_img
