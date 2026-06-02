from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
import socket
import webbrowser


HOST = "127.0.0.1"
PORT = 8765
OPEN_URL = f"http://localhost:{PORT}/aether.html"


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def port_is_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) != 0


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

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
