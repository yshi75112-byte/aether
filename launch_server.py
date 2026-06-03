from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import socket
from urllib.parse import parse_qs, urlparse
import webbrowser


HOST = "127.0.0.1"
PORT = 8765
OPEN_URL = f"http://localhost:{PORT}/aether.html"
PROJECT_ROOT = Path(__file__).resolve().parent

IGNORED_DIRS = {
    ".git",
    ".agents",
    ".codex",
    "__pycache__",
    "node_modules",
    "memory_backups",
}
IGNORED_FILES = {
    ".env",
    "memory.json",
    "last_server_url.txt",
}
SEARCH_EXTENSIONS = {
    ".bat",
    ".c",
    ".cfg",
    ".cmd",
    ".cpp",
    ".cs",
    ".css",
    ".csv",
    ".go",
    ".h",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".php",
    ".ps1",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
MAX_FILE_BYTES = 600_000
MAX_QUERY_LENGTH = 120
MAX_RESULTS = 20
MAX_READ_LINES = 220


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/debug/search":
            self._handle_debug_search(parsed)
            return
        if parsed.path == "/api/debug/read":
            self._handle_debug_read(parsed)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_debug_search(self, parsed):
        params = parse_qs(parsed.query)
        query = (params.get("q", [""])[0] or "").strip()
        if not query:
            self._send_json(400, {"error": "Missing query"})
            return
        if len(query) > MAX_QUERY_LENGTH:
            query = query[:MAX_QUERY_LENGTH]

        try:
            limit = min(MAX_RESULTS, max(1, int(params.get("limit", ["8"])[0])))
        except ValueError:
            limit = 8

        results = search_project_code(query, limit=limit)
        self._send_json(200, {"query": query, "root": str(PROJECT_ROOT), "results": results})

    def _handle_debug_read(self, parsed):
        params = parse_qs(parsed.query)
        rel_path = (params.get("file", [""])[0] or "").strip()
        if not rel_path:
            self._send_json(400, {"error": "Missing file"})
            return

        try:
            line = max(1, int(params.get("line", ["1"])[0]))
        except ValueError:
            line = 1

        try:
            context = min(MAX_READ_LINES, max(20, int(params.get("context", ["120"])[0])))
        except ValueError:
            context = 120

        try:
            payload = read_project_code(rel_path, line=line, context=context)
        except ValueError as exc:
            self._send_json(403, {"error": str(exc)})
            return
        except FileNotFoundError:
            self._send_json(404, {"error": "File not found"})
            return
        except UnicodeDecodeError:
            self._send_json(415, {"error": "File is not readable text"})
            return

        self._send_json(200, payload)


def safe_project_path(rel_path):
    candidate = (PROJECT_ROOT / rel_path).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise ValueError("Path is outside the project folder") from exc
    return candidate


def iter_searchable_files():
    for root, dirs, files in os.walk(PROJECT_ROOT):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        root_path = Path(root)
        for name in files:
            if name in IGNORED_FILES:
                continue
            path = root_path / name
            if path.suffix.lower() not in SEARCH_EXTENSIONS:
                continue
            try:
                resolved = path.resolve()
                resolved.relative_to(PROJECT_ROOT)
                if resolved.stat().st_size > MAX_FILE_BYTES:
                    continue
            except (OSError, ValueError):
                continue
            yield resolved


def read_text_lines(path):
    return path.read_text(encoding="utf-8").splitlines()


def search_project_code(query, limit=8):
    query_lower = query.lower()
    results = []

    for path in iter_searchable_files():
        rel_path = path.relative_to(PROJECT_ROOT).as_posix()
        try:
            lines = read_text_lines(path)
        except UnicodeDecodeError:
            continue

        for index, text in enumerate(lines):
            column = text.lower().find(query_lower)
            if column < 0:
                continue
            start = max(0, index - 2)
            end = min(len(lines), index + 3)
            results.append({
                "file": rel_path,
                "line": index + 1,
                "column": column + 1,
                "match": text.strip()[:260],
                "context": [
                    {"line": i + 1, "text": lines[i][:260]}
                    for i in range(start, end)
                ],
            })
            if len(results) >= limit:
                return results

    return results


def read_project_code(rel_path, line=1, context=120):
    path = safe_project_path(rel_path)
    if path.name in IGNORED_FILES or path.suffix.lower() not in SEARCH_EXTENSIONS:
        raise ValueError("File type is not allowed")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("File is too large")

    lines = read_text_lines(path)
    if not lines:
        return {"file": rel_path, "startLine": 1, "endLine": 1, "code": ""}

    target = min(max(1, line), len(lines)) - 1
    start, end = find_code_block(lines, target, path.suffix.lower(), context)
    code = "\n".join(f"{idx + 1}: {lines[idx]}" for idx in range(start, end))
    return {
        "file": path.relative_to(PROJECT_ROOT).as_posix(),
        "startLine": start + 1,
        "endLine": end,
        "code": code,
    }


def find_code_block(lines, target, suffix, context):
    if suffix == ".py":
        return find_python_block(lines, target, context)
    return find_brace_or_window_block(lines, target, context)


def find_python_block(lines, target, context):
    header_re = re.compile(r"^(\s*)(def|class)\s+\w+")
    start = None
    indent = 0
    for index in range(target, -1, -1):
        match = header_re.match(lines[index])
        if match:
            start = index
            indent = len(match.group(1))
            break
    if start is None:
        return window_block(lines, target, context)

    end = len(lines)
    for index in range(start + 1, len(lines)):
        text = lines[index]
        if text.strip() and len(text) - len(text.lstrip()) <= indent:
            end = index
            break
    return clamp_block(lines, start, end, target, context)


def find_brace_or_window_block(lines, target, context):
    header_re = re.compile(
        r"(function\s+\w+|class\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(?|"
        r"\w+\s*:\s*(?:async\s*)?function|addEventListener\s*\()"
    )
    start = None
    for index in range(target, -1, -1):
        if header_re.search(lines[index]):
            start = index
            break
    if start is None:
        return window_block(lines, target, context)

    depth = 0
    seen_open = False
    end = min(len(lines), start + context)
    for index in range(start, len(lines)):
        for char in lines[index]:
            if char == "{":
                depth += 1
                seen_open = True
            elif char == "}":
                depth -= 1
        if seen_open and depth <= 0 and index >= target:
            end = index + 1
            break
    return clamp_block(lines, start, end, target, context)


def window_block(lines, target, context):
    half = context // 2
    start = max(0, target - half)
    end = min(len(lines), start + context)
    start = max(0, end - context)
    return start, end


def clamp_block(lines, start, end, target, context):
    if end - start <= context:
        return max(0, start), min(len(lines), end)
    half = context // 2
    start = max(start, target - half)
    end = min(len(lines), start + context)
    return start, end


def port_is_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) != 0


def main():
    os.chdir(PROJECT_ROOT)

    if not port_is_available(HOST, PORT):
        print(f"Server already running: {OPEN_URL}")
        webbrowser.open(OPEN_URL)
        return

    server = ThreadingHTTPServer((HOST, PORT), NoCacheHandler)
    print(f"Serving Aether at {OPEN_URL}")
    webbrowser.open(OPEN_URL)
    server.serve_forever()


if __name__ == "__main__":
    main()
