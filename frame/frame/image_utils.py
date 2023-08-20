from PIL import Image

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
