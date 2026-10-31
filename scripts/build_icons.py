"""Convert satellite_icons/*.obj (low-poly icons, made with make_icons.py) into static/icons.json for Plotly mesh3d.

uv run python scripts/build_icons.py

Each icon becomes {x, y, z, i, j, k}: vertices normalised to fit a unit cube centred on the origin, quads split into
triangles. Colour is applied in close_approach.js (our satellite blue, the other object neutral + tier ring), so the
icon palettes in *.colors.json are not used: tier colours must keep their meaning.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "satellite_icons"
OUT = ROOT / "static" / "icons.json"
NAMES = ["own_satellite", "payload", "rocket_body", "debris", "unknown"]


def load_obj(path: Path) -> dict:
    verts, tris = [], []
    for line in path.read_text().splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            verts.append([float(v) for v in parts[1:4]])
        elif parts[0] == "f":
            idx = [int(p.split("/")[0]) - 1 for p in parts[1:]]
            tris += [(idx[0], idx[k], idx[k + 1]) for k in range(1, len(idx) - 1)]  # fan-triangulate
    lo = [min(v[a] for v in verts) for a in range(3)]
    hi = [max(v[a] for v in verts) for a in range(3)]
    centre = [(lo[a] + hi[a]) / 2 for a in range(3)]
    size = max(hi[a] - lo[a] for a in range(3)) or 1.0
    norm = [[round((v[a] - centre[a]) / size, 4) for a in range(3)] for v in verts]
    return {
        "x": [v[0] for v in norm],
        "y": [v[1] for v in norm],
        "z": [v[2] for v in norm],
        "i": [t[0] for t in tris],
        "j": [t[1] for t in tris],
        "k": [t[2] for t in tris],
    }


def main():
    icons = {name: load_obj(SRC / f"{name}.obj") for name in NAMES}
    OUT.write_text(json.dumps(icons, separators=(",", ":")))
    print({n: len(m["i"]) for n, m in icons.items()}, f"-> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
