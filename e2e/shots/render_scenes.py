"""Renders short synthetic "phone footage" clips for the demo screenshots.

Usage: python3 render_scenes.py <fire|bus|flood|tree> <out.mp4> <unique-comment>

The scenes are drawn procedurally (numpy + Pillow): no real footage, no copyright issues,
and each run can be made byte-unique with the comment tag. A little camera shake, blur and
sensor grain make them read like a witness's phone clip rather than a test pattern.
"""

import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter, zoom

W, H, FPS, SECONDS = 640, 360, 25, 8
rng = np.random.default_rng(7)


def gradient(top, bottom, h=H, w=W):
    t = np.linspace(0, 1, h)[:, None, None]
    return (np.array(top) * (1 - t) + np.array(bottom) * t) * np.ones((1, w, 1))


def noise(h, w, scale, seed):
    r = np.random.default_rng(seed)
    out = np.zeros((h, w))
    amp = 1.0
    for octave in range(4):
        s = max(2, int(scale * 2**octave))
        small = r.random((max(2, h * s // w), s))
        out += amp * zoom(small, (h / small.shape[0], w / small.shape[1]), order=3)[:h, :w]
        amp *= 0.5
    out -= out.min()
    return out / out.max()


def finish(img, t, shake=2.0):
    """Hand shake, slight blur, sensor grain and vignette."""
    dx = int(round(shake * np.sin(t * 2.3) + 0.6 * shake * np.sin(t * 5.1)))
    dy = int(round(shake * np.cos(t * 1.7) + 0.6 * shake * np.sin(t * 4.3)))
    img = np.roll(img, (dy, dx), axis=(0, 1))
    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    a = np.asarray(pil).astype(np.float32)
    a += rng.normal(0, 4.5, a.shape)
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.35 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    return np.clip(a * v[..., None], 0, 255).astype(np.uint8)


def draw_layer(size=(W, H)):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def texture(img, seed, amount=0.22):
    """Uneven light and grime on flat surfaces, so they don't look like flat cartoon fills."""
    n = noise(H, W, 40, seed)
    return img * (1 - amount / 2 + amount * n)[..., None]


def composite(base, layer):
    b = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert("RGBA")
    b.alpha_composite(layer)
    return np.asarray(b.convert("RGB")).astype(np.float32)


def buildings(d, y_base, palette, seed, lit=0.0, top=(110, 200)):
    r = np.random.default_rng(seed)
    x = -10
    while x < W:
        w = int(r.integers(45, 95))
        h = int(r.integers(*top))
        col = tuple(int(c) for c in palette[int(r.integers(len(palette)))])
        d.rectangle([x, y_base - h, x + w, y_base], fill=col + (255,))
        for wy in range(y_base - h + 10, y_base - 12, 18):
            for wx in range(x + 7, x + w - 10, 15):
                if lit and r.random() < lit:
                    d.rectangle([wx, wy, wx + 7, wy + 9], fill=(255, 200, 110, 230))
                elif not lit:
                    d.rectangle([wx, wy, wx + 7, wy + 9], fill=(60, 70, 85, 200))
        x += w + int(r.integers(0, 6))


# --------------------------------------------------------------------------- scenes


def scene_fire():
    sky = gradient((8, 10, 24), (46, 30, 40))
    layer, d = draw_layer()
    buildings(d, 250, [(18, 18, 26), (22, 22, 30), (16, 16, 22)], 3, lit=0.18, top=(60, 150))
    # The warehouse: a long low shed with a sloped roof.
    d.polygon([(140, 200), (330, 160), (500, 200), (500, 300), (140, 300)], fill=(34, 28, 28, 255))
    for wx in range(165, 480, 55):
        d.rectangle([wx, 235, wx + 30, 262], fill=(20, 16, 16, 255))
    d.rectangle([0, 300, W, H], fill=(28, 28, 30, 255))  # road
    for px in (60, 580):
        d.rectangle([px, 150, px + 4, 300], fill=(40, 40, 44, 255))
        d.ellipse([px - 8, 140, px + 12, 152], fill=(255, 220, 160, 255))
    base = composite(sky, layer)

    yy, xx = np.mgrid[0:H, 0:W]
    roof = np.where(xx < 330, 200 - (xx - 140) * 40 / 190, 160 + (xx - 330) * 40 / 170)
    inside = (xx > 150) & (xx < 490)
    height = 70 + 50 * np.exp(-((xx - 300) / 90) ** 2) + 30 * np.exp(-((xx - 430) / 40) ** 2)
    flame_mask = np.clip(1 - (roof - yy) / height, 0, 1) * (yy < roof + 8) * inside
    window_mask = np.zeros((H, W))
    for wx in range(165, 480, 55):
        window_mask[235:263, wx:wx + 31] = 0.9
    fire_noise = noise(H * 3, W, 10, 11)
    smoke_noise = noise(H * 3, W, 5, 12)
    for f in range(FPS * SECONDS):
        t = f / FPS
        off = int(t * 120) % (H * 2)
        n = fire_noise[H * 2 - off: H * 3 - off] if off else fire_noise[H * 2:]
        n = fire_noise[(np.arange(H) + H * 2 - off) % (H * 3)]
        flick = 0.9 + 0.1 * np.sin(t * 13)
        inten = np.clip((n * 1.25 - 0.35) * np.maximum(flame_mask, window_mask) * flick, 0, 1) ** 1.3
        sm = smoke_noise[(np.arange(H) + H * 2 - int(t * 40)) % (H * 3)]
        smoke_mask = np.clip((roof - 40 - yy) / 160, 0, 1) * np.exp(-((xx - 320 - (roof - yy) * 0.35) / 170) ** 2)
        smoke = np.clip(sm * 1.3 - 0.25, 0, 1) * smoke_mask
        img = base * (1 - 0.75 * smoke[..., None]) + np.array([70, 64, 62]) * 0.75 * smoke[..., None]
        fire = np.stack([np.clip(inten * 2.2, 0, 1), np.clip(inten * 1.7 - 0.45, 0, 1), np.clip(inten * 2 - 1.5, 0, 1)], -1) * 255
        glow = gaussian_filter(inten, 30) * 3.2
        img = img + fire + glow[..., None] * np.array([255, 120, 40]) * flick
        yield finish(img, t, 1.8)


def street(top_sky, bottom_sky, palette, seed):
    sky = gradient(top_sky, bottom_sky)
    layer, d = draw_layer()
    buildings(d, 215, palette, seed, top=(70, 150))
    d.polygon([(0, 215), (W, 215), (W, H), (0, H)], fill=(84, 84, 88, 255))
    d.polygon([(0, 215), (W, 215), (W, 228), (0, 228)], fill=(120, 116, 108, 255))  # footpath
    for i in range(6):
        y = 250 + i * 20
        d.rectangle([310 - i * 6, y, 330 + i * 6, y + 6 + i], fill=(225, 225, 215, 255))
    return sky, layer, d


PASTEL = [(214, 181, 140), (176, 196, 186), (205, 160, 150), (190, 186, 210), (225, 210, 170), (160, 175, 190)]


def person(d, x, y, s, col):
    d.ellipse([x - 5 * s, y - 34 * s, x + 5 * s, y - 24 * s], fill=(70, 50, 40, 255))
    d.rounded_rectangle([x - 7 * s, y - 24 * s, x + 7 * s, y], radius=3, fill=col + (255,))


def scene_bus():
    sky, layer, d = street((168, 176, 186), (208, 210, 214), PASTEL, 5)
    base = texture(composite(sky, layer), 31)
    # An overturned bus lying on its side across the road.
    bus, b = draw_layer((300, 110))
    b.rounded_rectangle([0, 10, 299, 100], radius=14, fill=(204, 78, 44, 255))
    b.rectangle([0, 55, 299, 66], fill=(240, 236, 226, 255))
    for wx in range(18, 280, 34):
        b.rectangle([wx, 20, wx + 26, 48], fill=(48, 60, 78, 255))
    for wx in (40, 240):
        b.ellipse([wx - 20, 88, wx + 20, 112], fill=(22, 22, 24, 255))
    bus = bus.rotate(-7, expand=True, resample=Image.BICUBIC)
    glass, g = draw_layer()
    for _ in range(140):
        gx, gy = rng.integers(150, 520), rng.integers(300, 345)
        g.point((int(gx), int(gy)), fill=(200, 215, 225, 200))
    people = [(90, 300, 1.2, (40, 70, 140)), (118, 304, 1.25, (180, 40, 60)), (540, 298, 1.15, (230, 230, 230)), (575, 305, 1.3, (60, 110, 70))]
    for f in range(FPS * SECONDS):
        t = f / FPS
        frame, fd = draw_layer()
        frame.alpha_composite(bus, (170, 205))
        for i, (x, y, s, col) in enumerate(people):
            person(fd, x + 3 * np.sin(t * 0.8 + i), y, s, col)
        img = composite(base, glass)
        img = composite(img, frame)
        yield finish(img, t, 2.2)


def scene_flood():
    sky = gradient((86, 92, 100), (128, 134, 140))
    layer, d = draw_layer()
    buildings(d, 240, [(150, 140, 125), (140, 150, 150), (165, 150, 140), (130, 135, 145)], 8, top=(80, 170))
    upper = texture(composite(sky, layer), 32)
    water_y = 238
    yy, xx = np.mgrid[0:H, 0:W]
    ripple = noise(H, W * 2, 18, 21)
    vehicles, v = draw_layer()
    v.rounded_rectangle([110, 262, 230, 300], radius=10, fill=(230, 200, 40, 255))  # auto-rickshaw roof
    v.rectangle([120, 270, 220, 286], fill=(40, 50, 60, 255))
    v.rounded_rectangle([400, 268, 560, 300], radius=12, fill=(200, 205, 210, 255))  # submerged car roof
    v.rectangle([420, 274, 540, 288], fill=(55, 65, 80, 255))
    drops = rng.random((900, 2)) * [W, H]
    for f in range(FPS * SECONDS):
        t = f / FPS
        img = upper.copy()
        refl = upper[np.clip(2 * water_y - yy, 0, H - 1), xx] * 0.45
        shift = int(t * 30) % W
        rp = ripple[:, shift:shift + W]
        water = np.array([108, 98, 78]) * 0.6 + refl * 0.55 + (rp[..., None] - 0.5) * 38
        img[water_y:] = water[water_y:]
        img = composite(img, vehicles)
        rain, rd = draw_layer()
        pts = (drops + [t * 40, t * 520]) % [W, H]
        for x, y in pts[: 500 + 100 * (f % 4)]:
            rd.line([(x, y), (x - 3, y + 14)], fill=(220, 225, 230, 90), width=1)
        img = composite(img, rain)
        yield finish(img, t, 1.5)


def scene_tree():
    sky, layer, d = street((150, 186, 214), (212, 224, 232), PASTEL, 13)
    for cx, cy, r in [(40, 170, 60), (600, 160, 70), (520, 185, 45)]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(56, 110, 52, 255))
    base = texture(composite(sky, layer), 33)
    trunk, tdraw = draw_layer()
    tdraw.polygon([(30, 330), (70, 352), (560, 250), (548, 236)], fill=(96, 66, 42, 255))
    tdraw.polygon([(30, 330), (56, 345), (548, 236), (545, 230)], fill=(118, 84, 54, 255))
    for x0, y0, x1, y1 in [(200, 300, 230, 255), (330, 275, 380, 300), (430, 258, 450, 220), (480, 250, 540, 280)]:
        tdraw.line([(x0, y0), (x1, y1)], fill=(90, 62, 40, 255), width=7)
    leaves = rng.random((260, 3)) * [420, 120, 1] + [170, 190, 0]
    scooter, s = draw_layer()
    s.ellipse([590, 296, 616, 322], fill=(25, 25, 25, 255))
    s.ellipse([540, 296, 566, 322], fill=(25, 25, 25, 255))
    s.polygon([(548, 300), (600, 300), (610, 280), (575, 276)], fill=(30, 90, 170, 255))
    for f in range(FPS * SECONDS):
        t = f / FPS
        frame, fd = draw_layer()
        frame.alpha_composite(trunk)
        for i, (x, y, k) in enumerate(leaves):
            sway = 2.5 * np.sin(t * 2 + i)
            g = int(90 + 70 * k)
            r = 9 + 6 * k
            fd.ellipse([x + sway - r, y - r, x + sway + r, y + r], fill=(40, g, 38, 235))
        frame.alpha_composite(scooter)
        person(fd, 620, 300, 1.2, (150, 60, 140))
        img = composite(base, frame)
        yield finish(img, t, 1.6)


SCENES = {"fire": scene_fire, "bus": scene_bus, "flood": scene_flood, "tree": scene_tree}


def main():
    name, out, comment = sys.argv[1], sys.argv[2], sys.argv[3]
    ff = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.08",
         "-t", str(SECONDS), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", "-metadata", f"comment={comment}", "-movflags", "+faststart", out],
        stdin=subprocess.PIPE,
    )
    for frame in SCENES[name]():
        ff.stdin.write(frame.tobytes())
    ff.stdin.close()
    sys.exit(ff.wait())


if __name__ == "__main__":
    main()
