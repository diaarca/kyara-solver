"""macOS bridge for read-only Kyara requests in an already authorized tab.

Credentials stay in the browser. No browser profiles, cookies, or account tokens
are read by Python. JavaScript execution requires the browser's explicit setting.
"""
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
from urllib.parse import urlsplit
import uuid

from .collector import DataError


def execute(js, application="com.vivaldi.Vivaldi"):
    if sys.platform != "darwin":
        raise DataError("Browser transport currently requires macOS; use HTTP transport or browser export elsewhere")
    if application not in ("com.vivaldi.Vivaldi", "com.google.Chrome", "com.brave.Browser"):
        raise DataError("Unsupported browser application")
    with tempfile.TemporaryDirectory(prefix="kyara-browser-") as temporary:
        source = Path(temporary) / "request.js"
        source.write_text(js)
        script = f'''set js to read POSIX file {json.dumps(str(source))} as «class utf8»
with timeout of 10 seconds
 tell application id "{application}" to set urlsByWindow to URL of every tab of every window
 repeat with wi from 1 to count of urlsByWindow
  set tabURLs to item wi of urlsByWindow
  repeat with ti from 1 to count of tabURLs
   if (item ti of tabURLs) starts with "https://kyara.games/" then
    tell application id "{application}" to return execute tab ti of window wi javascript js
   end if
  end repeat
 end repeat
 error "No open Kyara tab found"
end timeout'''
        response = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=15)
        if response.returncode:
            # AppleScript errors contain no evaluated page values or credentials.
            raise DataError("Browser automation failed: " + response.stderr.strip())
        return response.stdout.strip()


class BrowserResponse(io.BytesIO):
    headers = {"Content-Type": "application/json"}


class BrowserOpener:
    def __init__(self, application="com.vivaldi.Vivaldi", runner=execute, sleep=time.sleep):
        self.application, self.runner, self.sleep = application, runner, sleep

    def __call__(self, request, timeout=30):
        url = urlsplit(request.full_url)
        batch = (url.path == "/api/me/collection/prices" and
                 re.fullmatch(r"ids=[0-9]+(?:,[0-9]+){0,199}", url.query))
        rebirth = ((url.path == "/api/me/renaissance" and url.query == "fresh=1")
                   or (url.path == "/api/me/collection" and url.query == "lean=1"))
        public_data = (not url.query and (url.path in ("/api/characters", "/api/packs", "/api/rates", "/api/config")
            or re.fullmatch(r"/api/packs/[A-Za-z0-9_-]+/characters", url.path)
            or re.fullmatch(r"/api/characters/[0-9]+", url.path)
            or re.fullmatch(r"/api/market/prices/[0-9]+", url.path)))
        if (url.scheme != "https" or url.netloc != "kyara.games" or request.get_method() != "GET"
                or not (batch or public_data or rebirth)):
            raise DataError("Browser transport permits only read-only Kyara data routes")
        key = "__kyara_price_request_" + uuid.uuid4().hex
        path = url.path + "?" + url.query
        start = f'''(() => {{
if (location.origin !== 'https://kyara.games') throw new Error('Wrong origin');
const key={json.dumps(key)}, path={json.dumps(path)};
globalThis[key]={{done:false}};
(async()=>{{try{{
 const headers={{Accept:'application/json'}};
 const token=localStorage.getItem('kyara_token'), device=localStorage.getItem('kyara_device');
 if(token)headers.Authorization='Bearer '+token;
 if(device)headers['x-device-id']=device;
 const r=await fetch(path,{{method:'GET',headers,credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout({int(timeout * 1000)})}});
 const retryAfter=r.headers.get('Retry-After');
 if(!r.ok){{globalThis[key]={{done:true,status:r.status,retryAfter}};return;}}
 if(!(r.headers.get('content-type')||'').includes('json'))throw new Error('Non-JSON response');
 globalThis[key]={{done:true,status:r.status,body:await r.json()}};
}}catch(e){{globalThis[key]={{done:true,error:e.name==='TimeoutError'?'Browser request timed out': 'Browser request failed'}};}}}})();
return 'started';}})()'''
        self.runner(start, self.application)
        deadline = time.monotonic() + timeout + 5
        while time.monotonic() < deadline:
            poll = f'''(() => {{const key={json.dumps(key)},v=globalThis[key];
if(!v)return JSON.stringify({{done:true,error:'Browser request context lost'}});
if(!v.done)return JSON.stringify({{done:false}});
delete globalThis[key];return JSON.stringify(v);}})()'''
            value = json.loads(self.runner(poll, self.application))
            if not value.get("done"):
                self.sleep(.2)
                continue
            if value.get("error"):
                raise DataError(value["error"] + "; successful earlier batches remain checkpointed")
            if value["status"] != 200:
                headers = {"Retry-After": value["retryAfter"]} if value.get("retryAfter") else {}
                raise urllib.error.HTTPError(request.full_url, value["status"], "Kyara batch request failed", headers, io.BytesIO())
            return BrowserResponse(json.dumps(value["body"]).encode())
        raise DataError("Browser request timed out; no snapshot was published")
