## Pulls in every module so a type change surfaces everywhere at once.
import pixie
import pixie/fileformats/bmp, pixie/fileformats/gif, pixie/fileformats/jpeg
import pixie/fileformats/png, pixie/fileformats/ppm, pixie/fileformats/qoi
import pixie/fileformats/svg, pixie/fileformats/tiff, pixie/fileformats/webp
import pixie/imagebase64, pixie/internal, pixie/simd
echo "compiled"
