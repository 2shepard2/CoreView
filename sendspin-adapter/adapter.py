"""CoreView's pairing-capable SendSpin display/visualizer client."""

import asyncio
import logging
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

from aiohttp import web
from aiosendspin.client import ClientListener, SendspinClient
from aiosendspin.models.core import DeviceInfo
from aiosendspin.models.types import Roles, UndefinedField
from aiosendspin.models.visualizer import (
    ClientHelloVisualizerSpectrum,
    ClientHelloVisualizerSupport,
)

DATA_DIR = Path(os.getenv("SENDSPIN_DATA_DIR", "/app/data"))
CLIENT_ID_PATH = DATA_DIR / "client-id.txt"
CLIENT_PORT = int(os.getenv("SENDSPIN_CLIENT_PORT", "8928"))
STATUS_PORT = int(os.getenv("SENDSPIN_STATUS_PORT", "8929"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("aiosendspin").setLevel(logging.DEBUG)


def now() -> str:
    return datetime.now(UTC).isoformat()


def client_id_from_disk() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if CLIENT_ID_PATH.exists():
        return CLIENT_ID_PATH.read_text().strip()
    client_id = f"coreview-{uuid.uuid4()}"
    CLIENT_ID_PATH.write_text(client_id + "\n")
    CLIENT_ID_PATH.chmod(0o600)
    return client_id


class Adapter:
    def __init__(self) -> None:
        self.status = {
            "configured": True,
            "connected": False,
            "clientPort": CLIENT_PORT,
            "clientPath": "/sendspin",
            "pairingCode": None,
            "lastConnectedAt": None,
            "lastMessageAt": None,
            "lastError": None,
            "serverName": None,
            "activeRoles": [],
            "playbackState": "stopped",
            "metadata": {},
            "visualizer": {"active": False, "framesReceived": 0, "lastFrameAt": None, "bands": [], "level": 0, "peak": 0},
        }
        self.client: SendspinClient | None = None
        self.listener: ClientListener | None = None

    def on_metadata(self, payload) -> None:
        metadata = getattr(payload, "metadata", None)
        if not metadata or isinstance(metadata, UndefinedField):
            return
        fields = ("title", "artist", "album", "album_artist", "artwork_url")
        self.status["metadata"].update({key: value for key in fields if isinstance((value := getattr(metadata, key, None)), str)})
        progress = getattr(metadata, "progress", None)
        if progress and not isinstance(progress, UndefinedField):
            self.status["metadata"].update({"position": progress.track_progress, "duration": progress.track_duration})
        self.status["lastMessageAt"] = now()

    def on_group(self, payload) -> None:
        if getattr(payload, "playback_state", None):
            self.status["playbackState"] = payload.playback_state
        self.status["lastMessageAt"] = now()

    def on_visualizer(self, frames) -> None:
        if not frames:
            return
        latest = frames[-1]
        visualizer = self.status["visualizer"]
        spectrum = getattr(latest, "spectrum", None)
        if spectrum is not None:
            visualizer["bands"] = [max(0, min(255, int(value))) for value in spectrum]
        visualizer["level"] = max(0, min(255, int(getattr(latest, "loudness", 0) or 0)))
        visualizer["peak"] = max(0, min(255, int(getattr(latest, "peak_strength", 0) or 0)))
        visualizer["active"] = True
        visualizer["framesReceived"] += len(frames)
        visualizer["lastFrameAt"] = now()
        self.status["lastMessageAt"] = visualizer["lastFrameAt"]

    def on_disconnect(self) -> None:
        self.status["connected"] = False
        self.status["visualizer"]["active"] = False

    async def handle_connection(self, ws) -> None:
        assert self.client is not None
        await self.client.attach_websocket(ws)

    async def start(self) -> None:
        client_id = client_id_from_disk()
        visualizer_support = ClientHelloVisualizerSupport(
            buffer_capacity=65536,
            rate_max=20,
            types=["loudness", "peak", "spectrum", "beat"],
            spectrum=ClientHelloVisualizerSpectrum(n_disp_bins=16, scale="mel", f_min=40, f_max=16000),
        )
        logging.getLogger(__name__).info("Visualizer client support: %s", visualizer_support.to_dict())
        self.client = SendspinClient(
            client_id,
            "CoreView Music Visualizer",
            [Roles.METADATA, Roles.VISUALIZER],
            device_info=DeviceInfo(product_name="CoreView", manufacturer="CoreView", software_version="1"),
            visualizer_support=visualizer_support,
        )
        self.client.add_metadata_listener(self.on_metadata)
        self.client.add_group_update_listener(self.on_group)
        self.client.add_visualizer_listener(self.on_visualizer)
        self.client.add_disconnect_listener(self.on_disconnect)
        self.listener = ClientListener(client_id, self.handle_connection, port=CLIENT_PORT, advertise_mdns=False, client_name="CoreView Music Visualizer")
        await self.listener.start()

    async def stop(self) -> None:
        if self.listener:
            await self.listener.stop()
        if self.client:
            await self.client.disconnect()

    async def status_handler(self, _request: web.Request) -> web.Response:
        if self.client and self.client.connected:
            info = self.client.server_info
            self.status["connected"] = True
            self.status["lastConnectedAt"] = self.status["lastConnectedAt"] or now()
            self.status["serverName"] = getattr(info, "name", None)
            self.status["activeRoles"] = [role.value if hasattr(role, "value") else str(role) for role in self.client.roles]
            self.status["lastError"] = None
        return web.json_response(self.status)


async def main() -> None:
    adapter = Adapter()
    await adapter.start()
    app = web.Application()
    app.router.add_get("/health", lambda _request: web.Response(text="ok"))
    app.router.add_get("/status", adapter.status_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", STATUS_PORT)
    await site.start()
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
        await adapter.stop()


if __name__ == "__main__":
    asyncio.run(main())
