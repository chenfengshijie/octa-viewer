"""Media types exposed to the Viewer and OpenAPI consumers."""

from fastapi.responses import Response


class PngResponse(Response):
    media_type = "image/png"


PNG_OR_JSON = {200: {"content": {"image/png": {"schema": {"type": "string", "format": "binary"}}}}}
