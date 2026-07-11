#!/usr/bin/env python3
"""
Vizier server — YouTube transcripts, Wikipedia lookup, and optional OCR assist.

Install: pip install youtube-transcript-api wikipedia-api
Optional (OCR assist only): pip install easyocr pillow
Run:     python3 vizier_server.py
"""

import base64
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 11435

_ocr_reader = None


def get_ocr_reader():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(['en'], gpu=False)
    return _ocr_reader


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass  # silence default access logs

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/transcript':
            self._handle_transcript(parsed)
        elif parsed.path == '/health':
            self._reply(200, {'status': 'ok'})
        elif parsed.path == '/models/status':
            self._handle_models_status()
        elif parsed.path == '/wiki/search':
            self._handle_wiki_search(parsed)
        elif parsed.path == '/wiki/page':
            self._handle_wiki_page(parsed)
        else:
            self._reply(404, {'error': 'not found'})

    def do_POST(self) -> None:
        path_part = urlparse(self.path).path
        if path_part == '/ocr':
            self._handle_ocr()
        elif path_part == '/models/download':
            self._handle_models_download()
        else:
            self._reply(404, {'error': 'not found'})

    def _handle_transcript(self, parsed) -> None:
        video_id = parse_qs(parsed.query).get('video_id', [None])[0]
        if not video_id:
            self._reply(400, {'error': 'missing video_id'})
            return
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
            from youtube_transcript_api.formatters import TextFormatter
            transcript = YouTubeTranscriptApi().fetch(video_id)
            text = TextFormatter().format_transcript(transcript)
            self._reply(200, {'transcript': text})
        except ImportError:
            self._reply(503, {'error': 'youtube-transcript-api not installed. Run "Vizier: Setup / start Vizier server" to install dependencies.'})
        except Exception as e:
            self._reply(500, {'error': str(e)})

    def _handle_ocr(self) -> None:
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            self._reply(400, {'error': 'invalid JSON'})
            return
        image_b64 = data.get('image', '')
        if not image_b64:
            self._reply(400, {'error': 'missing image field'})
            return
        try:
            img_bytes = base64.b64decode(image_b64)
            reader = get_ocr_reader()
            results = reader.readtext(img_bytes, detail=0, paragraph=True)
            self._reply(200, {'text': '\n'.join(results)})
        except ImportError:
            self._reply(503, {'error': 'easyocr not installed. Run "Vizier: Setup / start Vizier server" to install dependencies.'})
        except Exception as e:
            self._reply(500, {'error': str(e)})

    def _handle_wiki_search(self, parsed) -> None:
        qs = parse_qs(parsed.query)
        query = qs.get('q', [None])[0]
        limit = int(qs.get('limit', ['8'])[0])
        if not query:
            self._reply(400, {'error': 'missing q'})
            return
        try:
            import wikipediaapi
            wiki = wikipediaapi.Wikipedia(
                user_agent='Vizier-Obsidian-Plugin/1.0',
                language='en'
            )
            results = wiki.search(query, limit=limit)
            items = []
            for title, page in results.pages.items():
                snippet = ''
                if page.search_meta:
                    raw = page.search_meta.snippet or ''
                    # Strip HTML tags from snippet
                    import re
                    snippet = re.sub(r'<[^>]+>', '', raw).strip()
                items.append({'title': title, 'snippet': snippet})
            self._reply(200, {'results': items})
        except ImportError:
            self._reply(503, {'error': 'wikipedia-api not installed. Run: pip install wikipedia-api'})
        except Exception as e:
            self._reply(500, {'error': str(e)})

    def _handle_wiki_page(self, parsed) -> None:
        title = parse_qs(parsed.query).get('title', [None])[0]
        if not title:
            self._reply(400, {'error': 'missing title'})
            return
        try:
            import wikipediaapi
            wiki = wikipediaapi.Wikipedia(
                user_agent='Vizier-Obsidian-Plugin/1.0',
                language='en'
            )
            page = wiki.page(title)
            if not page.exists():
                self._reply(404, {'error': 'page not found'})
                return
            # Collect candidate images for the user to choose from (up to 12)
            image_urls = []
            skip_keywords = {'icon', 'logo', 'flag', 'map', 'seal', 'coat', 'blank',
                             'signature', 'stub', 'red_x', 'question_mark', 'edit-clear',
                             'arrow', 'bullet', 'star', 'check', 'cross', 'wikimedia'}
            try:
                infos = page.images.imageinfo()
                for img_title, info_list in infos.items():
                    t = img_title.lower()
                    if any(k in t for k in skip_keywords):
                        continue
                    if not (t.endswith('.jpg') or t.endswith('.jpeg') or t.endswith('.png')):
                        continue
                    if info_list and info_list[0].url:
                        image_urls.append(info_list[0].url)
                        if len(image_urls) >= 12:
                            break
            except Exception:
                pass  # image lookup is best-effort
            self._reply(200, {
                'title': page.title,
                'summary': page.summary,
                'extract': page.text[:4000],
                'url': page.fullurl,
                'image_urls': image_urls,
            })
        except ImportError:
            self._reply(503, {'error': 'wikipedia-api not installed. Run: pip install wikipedia-api'})
        except Exception as e:
            self._reply(500, {'error': str(e)})

    def _handle_models_status(self) -> None:
        import os
        model_dir = os.path.expanduser('~/.EasyOCR/model')
        cached = (
            os.path.isdir(model_dir)
            and any(f.endswith('.pth') for f in os.listdir(model_dir))
        )
        try:
            import easyocr as _  # noqa: F401
            installed = True
        except ImportError:
            installed = False
        self._reply(200, {'cached': cached, 'installed': installed})

    def _handle_models_download(self) -> None:
        import threading

        def download() -> None:
            try:
                get_ocr_reader()
            except Exception:
                pass

        threading.Thread(target=download, daemon=True).start()
        self._reply(202, {'status': 'downloading'})

    def _cors_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Vizier server running on http://127.0.0.1:{PORT}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
