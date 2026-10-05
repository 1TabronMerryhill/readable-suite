#!/usr/bin/env python3
"""Deploy daymarket files via GitHub Contents API using the custom.github vault credential.

Usage: deploy_daymarket.py path/in/repo [path/in/repo ...]
Paths are repo-relative; local files resolve under ~/workspace/daymarket.
"""
import base64, json, sys, urllib.request, os

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

OWNER, REPO, BRANCH = "1TabronMerryhill", "daymarket", "main"
LOCAL_ROOT = os.path.expanduser("~/workspace/daymarket")
ALLOWED = ["api.github.com"]

def api(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Accept": "application/vnd.github+json"})
    add_surrogate_to_request(req, "custom.github", allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}

def ensure_repo():
    status, body = api("GET", f"https://api.github.com/repos/{OWNER}/{REPO}")
    if status == 200:
        print(f"repo exists: {body.get('full_name')}")
        return True
    status, body = api("POST", "https://api.github.com/user/repos",
                       {"name": REPO, "private": False,
                        "description": "DayMarket — a daily holiday. Static marketing + membership-capture MVP."})
    print(f"create repo: {status} " + (body.get("full_name", "") if status == 201 else str(body)[:150]))
    return status == 201

def get_sha(path):
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}"
    status, body = api("GET", url)
    if status == 200:
        return body.get("sha")
    return None

def push(path):
    local = os.path.join(LOCAL_ROOT, path)
    with open(local, "rb") as f:
        content = base64.b64encode(f.read()).decode()
    sha = get_sha(path)
    payload = {"message": f"DayMarket MVP: {path}", "content": content, "branch": BRANCH}
    if sha:
        payload["sha"] = sha
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{path}"
    status, body = api("PUT", url, payload)
    commit = (body.get("commit") or {}).get("sha", "")[:7]
    action = "updated" if sha else "created"
    print(f"{status} {action} {path} commit={commit} " +
          (body.get("message", "") if status >= 400 else ""))
    return status in (200, 201)

def main(paths):
    if not ensure_repo():
        sys.exit(1)
    ok = True
    for p in paths:
        try:
            ok = push(p) and ok
        except Exception as e:
            print(f"ERROR {p}: {e}")
            ok = False
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    main(sys.argv[1:])
