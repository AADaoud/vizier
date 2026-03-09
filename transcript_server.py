#!/usr/bin/env python3
"""
Transcript server for Vizier (Obsidian plugin).

Install: pip install youtube-transcript-api
Run:     python3 transcript_server.py
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter

PORT = 11435


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass  # silence default access logs

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/transcript":
            self._reply(404, {"error": "not found"})
            return

        video_id = parse_qs(parsed.query).get("video_id", [None])[0]
        if not video_id:
            self._reply(400, {"error": "missing video_id"})
            return

        try:
            transcript = YouTubeTranscriptApi().fetch(video_id)
            text = TextFormatter().format_transcript(transcript)
            self._reply(200, {"transcript": text})
        except Exception as e:
            self._reply(500, {"error": str(e)})

    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Transcript server running on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
