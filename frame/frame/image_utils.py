from typing import Optional

from PIL import Image
import numpy as np
import struct
import fcntl
import subprocess

from .logger import Logger

def scale_cover(image: Image.Image, target_width: int, target_height: int) -> Image.Image:
    # Determine the scaling factor for both dimensions
    scale_width = target_width / image.width
    scale_height = target_height / image.height
    
    # Choose the larger scaling factor to ensure the image covers the full area
    scale_factor = max(scale_width, scale_height)
    
    # Resize the image based on the chosen scaling factor
    new_width = round(image.width * scale_factor)
    new_height = round(image.height * scale_factor)
    image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)

    # Calculate cropping coordinates
    left = (image.width - target_width) / 2
    top = (image.height - target_height) / 2
    right = (image.width + target_width) / 2
    bottom = (image.height + target_height) / 2

    # Crop to the target size
    image = image.crop((left, top, right, bottom))

    return image

def scale_contain(image: Image.Image, target_width: int, target_height: int, background_color: str) -> Image.Image:
    # Determine the scaling factor for both dimensions
    scale_width = target_width / image.width
    scale_height = target_height / image.height
    
    # Choose the smaller scaling factor to ensure the entire image fits within the target area
    scale_factor = min(scale_width, scale_height)
    
    # Resize the image based on the chosen scaling factor
    new_width = round(image.width * scale_factor)
    new_height = round(image.height * scale_factor)
    image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Create a new blank white image of target size
    background = Image.new('RGB', (target_width, target_height), background_color or 'white')
    
    # Paste the scaled image onto the background
    offset = ((target_width - new_width) // 2, (target_height - new_height) // 2)
    background.paste(image, offset)

    return background

def scale_stretch(image: Image.Image, target_width: int, target_height: int) -> Image.Image:
    # Simply resize the image to the target dimensions
    image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
    return image

def scale_center(image: Image.Image, target_width: int, target_height: int, background_color: str) -> Image.Image:
    # Create a new blank white image of target size
    background = Image.new('RGB', (target_width, target_height), background_color or 'white')
    
    # Calculate offset to center the image
    offset = ((target_width - image.width) // 2, (target_height - image.height) // 2)
    
    # If the image is larger than the target dimensions, crop it
    if offset[0] < 0 or offset[1] < 0:
        left = max(0, -offset[0])
        top = max(0, -offset[1])
        right = image.width - max(0, offset[0])
        bottom = image.height - max(0, offset[1])
        image = image.crop((left, top, right, bottom))
        offset = ((target_width - image.width) // 2, (target_height - image.height) // 2)
    
    # Paste the image (or cropped version) onto the background
    background.paste(image, offset)
    
    return background

def draw_text_with_border(draw, position, text, font, font_color, border_color, border_width=1):
    x, y = position

    # Draw the border by offsetting the text by the thickness value in all directions
    for dx in range(-border_width, border_width+1):
        for dy in range(-border_width, border_width+1):
            draw.text((x+dx, y+dy), text, font=font, fill=border_color)

    # Draw the main text
    draw.text((x, y), text, fill=font_color, font=font)


def image_to_framebuffer(img: Image, fb_path='/dev/fb0', logger: Optional[Logger]=None):
    xres, yres, bpp, color_mode = get_framebuffer_info(fb_path)

    # Open and convert the image
    if img.width != xres or img.height != yres:
        img = img.resize((xres, yres))  # Make sure it fits the screen

    # Convert image data based on bit-depth
    if bpp == 16:
        mode = 'RGB565'
    elif bpp == 24:
        mode = color_mode or'RGB'
    elif bpp == 32:
        mode = color_mode or 'RGBX'
    else:
        raise ValueError(f"Unsupported bit-depth: {bpp}")

    if img.mode == 'RGB' and bpp == 16:
        pixels = rgb_to_rgb565(img)
    elif img.mode == 'RGB' and bpp == 32:
        pixels = rgb_to_rgbx(img, color_mode)
    else:
        pixels = img.convert(mode).tobytes("raw", mode)

    with open(fb_path, "wb") as f:
        f.write(pixels)

FBIOGET_VSCREENINFO = 0x4600

def get_framebuffer_info(fb_path='/dev/fb0'):
    format_str = 'IIIIIIIIIIIIIIIIIIII'
    buf = struct.pack(format_str, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    with open(fb_path, 'rb') as fb:
        res = fcntl.ioctl(fb.fileno(), FBIOGET_VSCREENINFO, buf)
        xres, yres, _, _, _, _, bpp, grayscale, red_offset, red_length, _, green_offset, green_length, _, blue_offset, blue_length, _, x_offset, x_length, _ = struct.unpack(format_str, res)

    if bpp not in [16, 24, 32]:
        raise ValueError(f"Unsupported bit-depth: {bpp}")

    # Sorting colors by their offset to determine the order
    colors = [('R', red_offset, red_length), ('G', green_offset, green_length), ('B', blue_offset, blue_length), ('X', x_offset, x_length)]
    colors = [color for color in colors if (color[2] or 0) > 0]
    colors = sorted(colors, key=lambda x: x[1])
    color_format = ''.join([color[0] for color in colors])

    return xres, yres, bpp, color_format

def get_bit_depth(img):
    mode_to_depth = {
        "1": 1,  # 1-bit pixels, black and white, stored with one pixel per byte
        "L": 8,  # 8-bit pixels, black and white
        "P": 8,  # 8-bit pixels, mapped to any other mode using a color palette
        "RGB": 24,  # 3x8-bit pixels, true color
        "RGBA": 32,  # 4x8-bit pixels, true color with transparency mask
        "CMYK": 32,  # 4x8-bit pixels, color separation
        "YCbCr": 24,  # 3x8-bit pixels, color video format
        "LAB": 24,  # 3x8-bit pixels, the L*a*b color space
        "HSV": 24,  # 3x8-bit pixels, Hue, Saturation, Value color space
        "I": 32,  # 32-bit signed integer pixels
        "F": 32,  # 32-bit floating point pixels
    }

    return mode_to_depth.get(img.mode, None)


def rgb_to_rgbx(img, color_mode = 'RGBX'):
    """Convert a PIL.Image in RGB mode to RGBX or similar mode."""
    r, g, b = img.split()

    # Convert channels to arrays
    r = np.asarray(r)
    g = np.asarray(g)
    b = np.asarray(b)
    x = np.zeros_like(r).astype(np.uint8)

    # Stack the channels along the third dimension and reshape into a single byte stream
    channels = ()
    for color in color_mode:
        if color == 'R':
            channels += (r,)
        elif color == 'G':
            channels += (g,)
        elif color == 'B':
            channels += (b,)
        elif color == 'X':
            channels += (x,)
        else:
            raise ValueError(f"Unsupported color mode: {color_mode}. Only letters R, G, B, and X are allowed.")

    return np.stack(channels, axis=-1).tobytes()


def rgb_to_rgb565(img, color_mode = 'RGBX'):
    """Convert a PIL.Image (in RGB mode) to RGB565 mode."""
    r, g, b = img.split()

    # Convert channels to arrays
    r = np.asarray(r).astype(np.uint16)
    g = np.asarray(g).astype(np.uint16)
    b = np.asarray(b).astype(np.uint16)

    # Perform the bit-wise operations for RGB565 conversion
    r565 = (r >> 3) << 11
    g565 = (g >> 2) << 5
    b565 = b >> 3

    # Combine and return as bytes
    return (r565 | g565 | b565).tobytes()


def try_to_disable_cursor_blinking():
    subprocess.run('sudo sh -c "setterm -cursor off > /dev/tty0"', shell=True)


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
