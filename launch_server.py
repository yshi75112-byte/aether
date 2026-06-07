from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import ast
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
MAX_SYMBOL_CODE_LINES = 900
MAX_CONTEXT_CODE_CHARS = 60_000
MAX_CONTEXT_SYMBOLS = 4
MAX_CONTEXT_FALLBACK_SNIPPETS = 2


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/debug/search":
            self._handle_debug_search(parsed)
            return
        if parsed.path == "/api/debug/read":
            self._handle_debug_read(parsed)
            return
        if parsed.path == "/api/debug/symbols":
            self._handle_debug_symbols(parsed)
            return
        if parsed.path == "/api/debug/function":
            self._handle_debug_function(parsed)
            return
        if parsed.path == "/api/debug/context":
            self._handle_debug_context(parsed)
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

    def _handle_debug_symbols(self, parsed):
        params = parse_qs(parsed.query)
        query = (params.get("q", [""])[0] or "").strip()
        if not query:
            self._send_json(400, {"error": "Missing query"})
            return
        if len(query) > MAX_QUERY_LENGTH:
            query = query[:MAX_QUERY_LENGTH]

        try:
            limit = min(MAX_RESULTS, max(1, int(params.get("limit", ["10"])[0])))
        except ValueError:
            limit = 10

        results = search_project_symbols(query, limit=limit)
        self._send_json(200, {"query": query, "root": str(PROJECT_ROOT), "results": results})

    def _handle_debug_function(self, parsed):
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
            payload = read_project_symbol(rel_path, line=line)
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

    def _handle_debug_context(self, parsed):
        params = parse_qs(parsed.query)
        query = (params.get("q", [""])[0] or "").strip()
        if not query:
            self._send_json(400, {"error": "Missing query"})
            return
        if len(query) > MAX_QUERY_LENGTH:
            query = query[:MAX_QUERY_LENGTH]

        try:
            limit = min(MAX_CONTEXT_SYMBOLS, max(1, int(params.get("limit", ["4"])[0])))
        except ValueError:
            limit = MAX_CONTEXT_SYMBOLS

        try:
            payload = build_code_context(query, limit=limit)
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


def extract_symbols_for_file(path):
    lines = read_text_lines(path)
    suffix = path.suffix.lower()
    rel_path = path.relative_to(PROJECT_ROOT).as_posix()
    if suffix == ".py":
        return extract_python_symbols(rel_path, lines)
    return extract_brace_symbols(rel_path, lines)


def extract_python_symbols(rel_path, lines):
    source = "\n".join(lines)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    symbols = []

    def visit(node, parents):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = child.lineno
                end = getattr(child, "end_lineno", None) or infer_python_end(lines, start)
                name = child.name
                kind = "class" if isinstance(child, ast.ClassDef) else "function"
                signature = lines[start - 1].strip() if 0 <= start - 1 < len(lines) else name
                symbols.append(make_symbol(rel_path, name, kind, start, end, signature, parents))
                visit(child, parents + [name])
            else:
                visit(child, parents)

    visit(tree, [])
    return symbols


def infer_python_end(lines, start_line):
    start = max(0, start_line - 1)
    header = lines[start]
    indent = len(header) - len(header.lstrip())
    end = len(lines)
    for index in range(start + 1, len(lines)):
        text = lines[index]
        if text.strip() and len(text) - len(text.lstrip()) <= indent:
            end = index
            break
    return end


def extract_brace_symbols(rel_path, lines):
    patterns = [
        ("class", re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)\b")),
        ("function", re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(")),
        ("function", re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")),
        ("function", re.compile(r"^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function\b")),
        ("function", re.compile(r"^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{")),
    ]
    ignored_names = {"if", "for", "while", "switch", "catch", "function", "return"}
    symbols = []
    seen = set()

    for index, text in enumerate(lines):
        for kind, pattern in patterns:
            match = pattern.search(text)
            if not match:
                continue
            name = match.group(1)
            if name in ignored_names:
                continue
            end = find_brace_symbol_end(lines, index)
            key = (name, index + 1, end)
            if key in seen:
                continue
            seen.add(key)
            signature = text.strip()
            symbols.append(make_symbol(rel_path, name, kind, index + 1, end, signature, []))
            break

    return symbols


def find_brace_symbol_end(lines, start_index):
    depth = 0
    seen_open = False
    for index in range(start_index, len(lines)):
        masked = mask_strings_for_brace_count(lines[index])
        for char in masked:
            if char == "{":
                depth += 1
                seen_open = True
            elif char == "}":
                depth -= 1
        if seen_open and depth <= 0 and index >= start_index:
            return index + 1

        stripped = lines[index].strip()
        if not seen_open and index > start_index and stripped.endswith(";"):
            return index + 1

    return min(len(lines), start_index + MAX_SYMBOL_CODE_LINES)


def mask_strings_for_brace_count(text):
    result = []
    quote = None
    escape = False
    index = 0
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if quote:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = None
            result.append(" ")
        else:
            if char == "/" and next_char == "/":
                result.extend(" " * (len(text) - index))
                break
            if char in {"'", '"', "`"}:
                quote = char
                result.append(" ")
            else:
                result.append(char)
        index += 1
    return "".join(result)


def make_symbol(rel_path, name, kind, start_line, end_line, signature, parents):
    parent = ".".join(parents) if parents else ""
    return {
        "file": rel_path,
        "name": name,
        "kind": kind,
        "startLine": max(1, start_line),
        "endLine": max(start_line, end_line),
        "signature": signature[:260],
        "parent": parent,
    }


def symbol_body_text(symbol, lines):
    start = max(0, symbol["startLine"] - 1)
    end = min(len(lines), symbol["endLine"])
    return "\n".join(lines[start:end])


def score_symbol(symbol, query, body):
    query_lower = query.lower()
    tokens = [part for part in re.split(r"\W+", query_lower) if len(part) >= 2]
    name = symbol["name"].lower()
    signature = symbol["signature"].lower()
    file_name = symbol["file"].lower()
    body_lower = body.lower()
    score = 0

    if query_lower == name:
        score += 120
    elif query_lower in name:
        score += 90
    if query_lower in signature:
        score += 70
    if query_lower in file_name:
        score += 35
    if query_lower in body_lower:
        score += 30

    for token in tokens:
        if token == name:
            score += 60
        elif token in name:
            score += 35
        if token in signature:
            score += 25
        if token in file_name:
            score += 15
        if token in body_lower:
            score += 8

    length = symbol["endLine"] - symbol["startLine"] + 1
    if length <= 8:
        score -= 3
    return score


def search_project_symbols(query, limit=10):
    scored = []
    for path in iter_searchable_files():
        try:
            lines = read_text_lines(path)
        except UnicodeDecodeError:
            continue

        suffix = path.suffix.lower()
        rel_path = path.relative_to(PROJECT_ROOT).as_posix()
        symbols = extract_python_symbols(rel_path, lines) if suffix == ".py" else extract_brace_symbols(rel_path, lines)
        for symbol in symbols:
            body = symbol_body_text(symbol, lines)
            score = score_symbol(symbol, query, body)
            if score <= 0:
                continue
            preview = first_non_empty_line(body, after_first=True)
            scored.append({**symbol, "score": score, "preview": preview})

    scored.sort(key=lambda item: (-item["score"], item["file"], item["startLine"]))
    return scored[:limit]


def first_non_empty_line(text, after_first=False):
    lines = text.splitlines()
    if after_first:
        lines = lines[1:]
    for line in lines:
        stripped = line.strip()
        if stripped:
            return stripped[:260]
    return ""


def read_project_symbol(rel_path, line=1):
    path = safe_project_path(rel_path)
    if path.name in IGNORED_FILES or path.suffix.lower() not in SEARCH_EXTENSIONS:
        raise ValueError("File type is not allowed")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("File is too large")

    lines = read_text_lines(path)
    if not lines:
        return {"file": rel_path, "startLine": 1, "endLine": 1, "code": "", "kind": "empty"}

    suffix = path.suffix.lower()
    rel = path.relative_to(PROJECT_ROOT).as_posix()
    symbols = extract_python_symbols(rel, lines) if suffix == ".py" else extract_brace_symbols(rel, lines)
    target = min(max(1, line), len(lines))
    containing = [
        symbol for symbol in symbols
        if symbol["startLine"] <= target <= symbol["endLine"]
    ]

    if containing:
        containing.sort(key=lambda item: (
            item["endLine"] - item["startLine"],
            0 if item["kind"] == "function" else 1,
        ))
        symbol = containing[0]
        return symbol_payload(symbol, lines)

    start, end = find_code_block(lines, target - 1, suffix, MAX_READ_LINES)
    code = "\n".join(f"{idx + 1}: {lines[idx]}" for idx in range(start, end))
    return {
        "file": rel,
        "name": "",
        "kind": "snippet",
        "startLine": start + 1,
        "endLine": end,
        "signature": "",
        "parent": "",
        "code": code,
        "truncated": False,
    }


def symbol_payload(symbol, lines):
    start = max(0, symbol["startLine"] - 1)
    end = min(len(lines), symbol["endLine"])
    truncated = False
    if end - start > MAX_SYMBOL_CODE_LINES:
        end = start + MAX_SYMBOL_CODE_LINES
        truncated = True
    code = "\n".join(f"{idx + 1}: {lines[idx]}" for idx in range(start, end))
    return {
        **symbol,
        "endLine": end,
        "code": code,
        "truncated": truncated,
    }


def build_code_context(query, limit=MAX_CONTEXT_SYMBOLS):
    symbol_hits = search_project_symbols(query, limit=limit * 3)
    symbols = []
    seen = set()
    total_chars = 0

    for hit in symbol_hits:
        key = (hit["file"], hit["startLine"], hit["endLine"])
        if key in seen:
            continue
        seen.add(key)
        detail = read_project_symbol(hit["file"], line=hit["startLine"])
        projected = total_chars + len(detail.get("code", ""))
        if projected > MAX_CONTEXT_CODE_CHARS and symbols:
            break
        total_chars = projected
        detail["score"] = hit.get("score", 0)
        symbols.append(detail)
        if len(symbols) >= limit:
            break

    fallback_snippets = []
    if len(symbols) < limit:
        for result in search_project_code(query, limit=MAX_CONTEXT_FALLBACK_SNIPPETS * 3):
            key = (result["file"], result["line"])
            if key in seen:
                continue
            seen.add(key)
            detail = read_project_code(result["file"], line=result["line"], context=120)
            projected = total_chars + len(detail.get("code", ""))
            if projected > MAX_CONTEXT_CODE_CHARS and (symbols or fallback_snippets):
                break
            total_chars = projected
            fallback_snippets.append(detail)
            if len(fallback_snippets) >= MAX_CONTEXT_FALLBACK_SNIPPETS:
                break

    return {
        "query": query,
        "root": str(PROJECT_ROOT),
        "symbols": symbols,
        "fallbackSnippets": fallback_snippets,
        "totalCodeChars": total_chars,
    }


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
