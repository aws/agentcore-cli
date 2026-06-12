"""Skill fetcher — downloads s3/git skills to local filesystem on first use.

Resolved paths are passed to AgentSkills(skills=...) in main.py.
Cache directory: .agents/skills/ (persists across invocations within the same session).
"""

import base64
import hashlib
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SKILLS_BASE = Path(".agents/skills")
_GIT_TIMEOUT = 60
_S3_MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024  # 1 GB


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def _safe_skill_path(base: Path, skill_path: str) -> Path:
    if not skill_path:
        return base
    resolved = (base / skill_path).resolve()
    if not str(resolved).startswith(str(base.resolve()) + os.sep):
        raise ValueError(f"skill_path '{skill_path}' escapes the skill directory")
    return resolved


def _read_map(type_dir: Path) -> dict:
    map_file = type_dir / ".map.json"
    return json.loads(map_file.read_text()) if map_file.exists() else {}


def _write_map(type_dir: Path, mapping: dict) -> None:
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / ".map.json").write_text(json.dumps(mapping))


def _fetch_s3_skill(source: str, s3_client=None) -> Path:
    """Download an s3:// skill prefix and return the local directory."""
    key = _stable_hash(source)
    type_dir = _SKILLS_BASE / "s3"
    mapping = _read_map(type_dir)
    if key in mapping:
        skill_dir = type_dir / mapping[key]
        if skill_dir.exists():
            return skill_dir

    import boto3
    client = s3_client or boto3.client("s3")
    bucket, prefix = source[5:].split("/", 1)
    skill_name = prefix.rstrip("/").rsplit("/", 1)[-1]
    skill_dir = type_dir / skill_name
    shutil.rmtree(skill_dir, ignore_errors=True)
    skill_dir.mkdir(parents=True, exist_ok=True)

    paginator = client.get_paginator("list_objects_v2")
    total = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            total += obj["Size"]
            if total > _S3_MAX_SIZE_BYTES:
                shutil.rmtree(skill_dir, ignore_errors=True)
                raise ValueError(f"S3 skill {source} exceeds 1 GB size limit")
            rel = obj["Key"][len(prefix):]
            dest = skill_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, obj["Key"], str(dest))

    mapping[key] = skill_name
    _write_map(type_dir, mapping)
    return skill_dir


def _build_git_auth_env(credential_arn: Optional[str], username: Optional[str], identity_client=None) -> dict:
    """Build GIT_CONFIG_* env vars for HTTP Basic auth using a Token Vault credential ARN.

    Uses env vars instead of -c args to avoid leaking credentials in /proc/*/cmdline,
    and so auth propagates to sub-commands (e.g. sparse-checkout triggering a fetch).
    """
    if not credential_arn or not identity_client:
        return {}
    from bedrock_agentcore.services.identity import IdentityClient  # noqa: PLC0415
    password = identity_client.get_token(credential_arn)
    user = username or "oauth2"
    encoded = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {encoded}",
    }


def _fetch_git_skill(url: str, skill_path: str = "", credential_arn: Optional[str] = None,
                     username: Optional[str] = None, identity_client=None) -> Path:
    """Shallow-clone a git skill repository and return the local skill directory."""
    cache_key = _stable_hash(f"{url}:{skill_path}")
    type_dir = _SKILLS_BASE / "git"
    mapping = _read_map(type_dir)
    if cache_key in mapping:
        skill_dir = type_dir / mapping[cache_key]
        if skill_dir.exists():
            return _safe_skill_path(skill_dir, skill_path)

    skill_name = skill_path.rstrip("/").rsplit("/", 1)[-1] or url.rsplit("/", 1)[-1].removesuffix(".git")
    clone_dir = type_dir / skill_name
    shutil.rmtree(clone_dir, ignore_errors=True)
    clone_dir.mkdir(parents=True, exist_ok=True)

    extra_env = _build_git_auth_env(credential_arn, username, identity_client)
    git_env = {**os.environ, **extra_env} if extra_env else None

    try:
        if skill_path:
            subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", url, str(clone_dir)],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, env=git_env,
            )
            subprocess.run(
                ["git", "sparse-checkout", "set", skill_path],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, cwd=str(clone_dir), env=git_env,
            )
        else:
            subprocess.run(
                ["git", "clone", "--depth", "1", url, str(clone_dir)],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, env=git_env,
            )
    except Exception:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise

    mapping[cache_key] = skill_name
    _write_map(type_dir, mapping)
    return _safe_skill_path(clone_dir, skill_path)


def resolve_s3_skills(sources: list, s3_client=None) -> list:
    """Resolve s3:// skill URIs to local filesystem paths."""
    paths = []
    for uri in sources:
        try:
            skill_dir = _fetch_s3_skill(uri, s3_client)
            paths.append(str(skill_dir.resolve()))
        except Exception as e:
            logger.warning("Failed to resolve S3 skill %s: %s", uri, e)
    return paths


def resolve_git_skills(sources: list, identity_client=None) -> list:
    """Resolve git skill dicts to local filesystem paths.

    Each source is a dict with keys: url (required), path (optional),
    credentialArn (optional), username (optional).
    """
    paths = []
    for source in sources:
        try:
            skill_dir = _fetch_git_skill(
                url=source["url"],
                skill_path=source.get("path") or "",
                credential_arn=source.get("credentialArn"),
                username=source.get("username"),
                identity_client=identity_client,
            )
            paths.append(str(skill_dir.resolve()))
        except Exception as e:
            logger.warning("Failed to resolve git skill %s: %s", source.get("url", source), e)
    return paths
