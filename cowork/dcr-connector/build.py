#!/usr/bin/env python3
"""Generate generic icons and a Cowork-only manifest candidate with verified publisher inputs."""

import argparse
import colorsys
import ipaddress
import json
import re
import struct
import sys
import uuid
import zipfile
import zlib
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
ENDPOINT = "https://mcp.datadoghq.com/v1/mcp"
SCHEMA = "https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json"
ICON_FILES = ("color.png", "outline.png")


class BuildError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise BuildError(message)


def rgb(hue, saturation, lightness):
    channels = colorsys.hls_to_rgb(hue / 360, lightness / 100, saturation / 100)
    return tuple(round(value * 255) for value in channels) + (255,)


NAVY = rgb(200, 16, 8)
DEEP = rgb(206, 30, 5)
CYAN = rgb(186, 100, 58)
BLUE = rgb(206, 100, 42)
PURPLE = rgb(257, 100, 62)
MAGENTA = rgb(291, 100, 58)
GREEN = rgb(142, 71, 40)
NITROUS = rgb(214, 100, 58)
FOREGROUND = (234, 242, 251, 255)
TRANSPARENT = (0, 0, 0, 0)


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(
        ">I", zlib.crc32(kind + data) & 0xFFFFFFFF
    )


def encode_png(pixels):
    height = len(pixels)
    width = len(pixels[0])
    raw = b"".join(
        b"\0" + b"".join(bytes(pixel) for pixel in row) for row in pixels
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def render_icon(size, outline=False):
    background = TRANSPARENT if outline else DEEP
    pixels = [[background for _ in range(size)] for _ in range(size)]
    scale = size / 192

    def box(x0, y0, x1, y1, color):
        for y in range(round(y0 * scale), round(y1 * scale)):
            for x in range(round(x0 * scale), round(x1 * scale)):
                pixels[y][x] = color

    if not outline:
        box(12, 12, 180, 180, NAVY)
    frame = FOREGROUND if outline else NITROUS
    signal = FOREGROUND if outline else CYAN
    box(28, 28, 164, 34, frame)
    box(28, 158, 164, 164, frame)
    box(28, 28, 34, 164, frame)
    box(158, 28, 164, 164, frame)
    if not outline:
        for x, color in ((44, CYAN), (58, BLUE), (72, PURPLE)):
            box(x, 44, x + 7, 51, color)
        box(41, 60, 151, 63, BLUE)
    box(49, 96, 68, 139, signal)
    box(77, 80, 96, 139, FOREGROUND if outline else BLUE)
    box(105, 105, 124, 139, FOREGROUND if outline else PURPLE)
    if not outline:
        box(132, 90, 144, 102, MAGENTA)
        box(132, 112, 144, 124, GREEN)
    return encode_png(pixels)


def write_icons(replace=False):
    assets = (
        ("color.png", 192, False),
        ("outline.png", 32, True),
    )
    for filename, _, _ in assets:
        path = ROOT / filename
        require(not path.is_symlink(), "Icon paths must not be symlinks.")
        require(replace or not path.exists(), "Icons already exist; use --replace to regenerate.")
    for filename, size, outline in assets:
        path = ROOT / filename
        path.write_bytes(render_icon(size, outline))


def verified_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        require(
            parsed.scheme == "https"
            and parsed.port in (None, 443)
            and host is not None
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and parsed.netloc == host
            and re.fullmatch(r"[a-z0-9.-]+", host) is not None
            and "." in host
            and all(
                re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in host.split(".")
            ),
            "Publisher URLs must be HTTPS DNS URLs without credentials, query or fragment.",
        )
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise BuildError("IP-address publisher URLs are not accepted.")
        require(
            not host.endswith((".example", ".test", ".invalid", ".local", ".internal"))
            and not any(
                host == reserved or host.endswith("." + reserved)
                for reserved in ("example.com", "example.org", "example.net")
            )
            and not value.endswith("/placeholder"),
            "Replace placeholder URLs with verified publisher policies.",
        )
    except (TypeError, ValueError) as error:
        if isinstance(error, BuildError):
            raise
        raise BuildError("Publisher URL is malformed.") from error
    return value


def make_manifest(app_id, developer_name, website_url, privacy_url, terms_url):
    try:
        app_uuid = uuid.UUID(app_id)
    except (ValueError, AttributeError, TypeError) as error:
        raise BuildError("Supply a real application UUID.") from error
    require(
        str(app_uuid) == app_id.lower() and app_uuid.int != 0,
        "Supply a canonical, nonzero application UUID.",
    )
    require(
        isinstance(developer_name, str)
        and 1 <= len(developer_name.strip()) <= 64
        and not any(ord(character) < 32 for character in developer_name),
        "Supply a real publisher name (1-64 characters).",
    )
    return {
        "$schema": SCHEMA,
        "manifestVersion": "1.28",
        "version": "0.1.0",
        "id": str(app_uuid),
        "developer": {
            "name": developer_name.strip(),
            "websiteUrl": verified_url(website_url),
            "privacyUrl": verified_url(privacy_url),
            "termsOfUseUrl": verified_url(terms_url),
        },
        "name": {
            "short": "Datadog MCP connection",
            "full": "Datadog MCP connection for Microsoft 365 Copilot Cowork",
        },
        "description": {
            "short": "Connect Datadog's remote MCP server to Copilot Cowork.",
            "full": (
                "Independent connector to Datadog's existing US1 remote MCP server. "
                "For read-only use, choose Datadog's Limited authorization profile "
                "if offered. This manifest cannot enforce the vendor's consent "
                "choice or role permissions. Availability, sign-in, DCR compatibility "
                "and tenant policy must be verified by the publisher before deployment."
            ),
        },
        "icons": {"color": "color.png", "outline": "outline.png"},
        "accentColor": "#0B181D",
        "agentConnectors": [
            {
                "id": "datadogMcp",
                "displayName": "Datadog MCP connection",
                "description": "Datadog US1 MCP. Choose Limited if offered for read-only use.",
                "toolSource": {"remoteMcpServer": {"mcpServerUrl": ENDPOINT}},
            }
        ],
    }


def package(output, manifest):
    output = Path(output)
    require(output.suffix.lower() == ".zip", "Output must be a ZIP file.")
    require(output.parent.is_dir() and not output.parent.is_symlink(), "Choose an existing real output directory.")
    require(not output.exists() and not output.is_symlink(), "Output already exists; never overwrite it.")
    icons = {}
    for filename, size, outline in (
        ("color.png", 192, False),
        ("outline.png", 32, True),
    ):
        path = ROOT / filename
        require(path.is_file() and not path.is_symlink(), "A required icon is missing or unsafe.")
        data = path.read_bytes()
        require(data == render_icon(size, outline), "A required icon differs from the original generic artwork.")
        icons[filename] = data
    contents = {
        "manifest.json": (json.dumps(manifest, indent=2, ensure_ascii=True) + "\n").encode("utf-8"),
        **icons,
    }
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(contents.items()):
            entry = zipfile.ZipInfo(name, (2026, 9, 24, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    with zipfile.ZipFile(output) as archive:
        require(
            set(archive.namelist()) == set(contents) and archive.testzip() is None,
            "Candidate ZIP verification failed.",
        )
    return output


def wizard(output):
    print(
        "Cowork-only local package preparation. Do not paste an OAuth URL, state, "
        "challenge, client ID, token, or secret. This does not connect or upload."
    )
    try:
        app_id = input(
            "App manifest UUID (blank to generate a new package UUID, NOT an OAuth client ID): "
        ).strip()
        if not app_id:
            app_id = str(uuid.uuid4())
            print(
                "Generated a new app manifest UUID; keep it stable for future updates. "
                "It is NOT an OAuth client ID."
            )
        developer_name = input("Verified publisher name: ").strip()
        website_url = input("Publisher HTTPS website URL: ").strip()
        privacy_url = input("Publisher HTTPS privacy policy URL: ").strip()
        terms_url = input("Publisher HTTPS terms-of-use URL: ").strip()
        manifest = make_manifest(app_id, developer_name, website_url, privacy_url, terms_url)
        acknowledgement = input(
            "Publisher identity and policy URLs verified? Type VERIFIED: "
        ).strip()
    except EOFError as error:
        raise BuildError("Wizard inputs were incomplete; no candidate was created.") from error
    require(acknowledgement == "VERIFIED", "Explicit publisher confirmation is required.")
    return package(output, manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    icons = commands.add_parser("icons", help="Generate original generic spectrum icons.")
    icons.add_argument("--replace", action="store_true")
    candidate = commands.add_parser(
        "package", help="Build a Cowork-only candidate after verifying publisher inputs."
    )
    candidate.add_argument("--app-id", required=True)
    candidate.add_argument("--developer-name", required=True)
    candidate.add_argument("--website-url", required=True)
    candidate.add_argument("--privacy-url", required=True)
    candidate.add_argument("--terms-url", required=True)
    candidate.add_argument("--confirm-urls-verified", action="store_true", required=True)
    candidate.add_argument("--output", required=True)
    guided = commands.add_parser(
        "wizard", help="Interactively collect public publisher metadata; never OAuth credentials."
    )
    guided.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "icons":
            write_icons(args.replace)
            print("Original generic icons generated. No manifest or upload package created.")
        else:
            if args.command == "wizard":
                path = wizard(args.output)
            else:
                manifest = make_manifest(
                    args.app_id, args.developer_name, args.website_url,
                    args.privacy_url, args.terms_url,
                )
                path = package(args.output, manifest)
            print(
                f"Created {path.name}: Cowork-only candidate, not DCR- or tenant-validated. "
                "No auth config was fabricated. Next: review schema and tenant policy, "
                "run guarded discovery, then choose Limited if offered for read-only use."
            )
    except (BuildError, OSError, zipfile.BadZipFile) as error:
        message = str(error) if isinstance(error, BuildError) else "Could not create the candidate package."
        print("ERROR: " + message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
