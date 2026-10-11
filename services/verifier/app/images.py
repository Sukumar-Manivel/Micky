"""Safe decoding of uploaded frames.

Every frame comes from our own worker, but we still treat it as untrusted input:
an uploader controls the original photo, and image decoders are a classic attack
surface. So we check size, format and pixel count *before* decoding the pixels.
"""

from __future__ import annotations

import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

# Only these container formats are accepted as frames (docs/API.md: JPEG files;
# PNG is allowed too because it is lossless and handy for tests).
ALLOWED_FORMATS: frozenset[str] = frozenset({"JPEG", "PNG"})


class FrameError(ValueError):
    """A frame was rejected. ``status_code`` is the HTTP status to return."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def configure_pillow(max_image_pixels: int) -> None:
    """Set Pillow's global decompression-bomb limit.

    Pillow warns above ``MAX_IMAGE_PIXELS`` and raises above twice that. We turn
    the warning into an error too, and additionally check the size ourselves in
    :func:`decode_frame`, so the effective limit is exactly ``max_image_pixels``.
    """
    Image.MAX_IMAGE_PIXELS = max_image_pixels
    warnings.simplefilter("error", Image.DecompressionBombWarning)


def decode_frame(data: bytes, *, index: int, max_bytes: int, max_pixels: int) -> Image.Image:
    """Validate and decode one frame into an RGB image.

    Raises:
        FrameError: 413 if too large, 415 if not a valid JPEG/PNG.
    """
    label = f"frame {index}"
    if len(data) == 0:
        raise FrameError(f"{label} is empty", 400)
    if len(data) > max_bytes:
        raise FrameError(f"{label} exceeds {max_bytes} bytes", 413)

    try:
        # Image.open only parses the header; pixels are decoded by .load().
        img = Image.open(io.BytesIO(data))
        if img.format not in ALLOWED_FORMATS:
            raise FrameError(f"{label} must be JPEG or PNG", 415)
        width, height = img.size
        if width * height > max_pixels:
            raise FrameError(f"{label} has too many pixels ({width}x{height})", 413)
        img.load()  # Decode now, so truncated/corrupt files fail here, not later.
    except FrameError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise FrameError(f"{label} has too many pixels", 413) from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        # Pillow raises a mix of these for corrupt or non-image data.
        raise FrameError(f"{label} is not a valid JPEG or PNG image", 415) from exc

    # Respect the EXIF orientation flag so a rotated phone photo is hashed and
    # classified the way a human sees it, then normalise to 3-channel RGB.
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")
