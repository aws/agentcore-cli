"""Skill fetcher — downloads s3/git skills to local filesystem on first use.

Resolved paths are passed to AgentSkills(skills=...) in main.py.
Cache directory: <tmpdir>/.agents/skills/ — an absolute path under the system temp
directory (honors $TMPDIR, defaults to /tmp). The runtime working directory (e.g.
/var/task in a CodeZip runtime) is read-only, so the cache must live somewhere
guaranteed-writable.
"""

import base64
import hashlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_SKILLS_BASE = Path(tempfile.gettempdir()) / ".agents" / "skills"
_GIT_TIMEOUT = 60
_S3_MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024  # 1 GB


def _stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def _cleanup(path: Path) -> None:
    """Remove a partially-created skill directory so retries don't see stale state."""
    shutil.rmtree(path, ignore_errors=True)


def _read_map(type_dir: Path) -> dict:
    map_file = type_dir / ".map.json"
    return json.loads(map_file.read_text()) if map_file.exists() else {}


def _write_map(type_dir: Path, mapping: dict) -> None:
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / ".map.json").write_text(json.dumps(mapping))


def _resolve_cached(type_dir: Path, source_hash: str) -> Optional[str]:
    """Return the cached skill directory for a source hash, or None if not on disk."""
    mapping = _read_map(type_dir)
    dir_name = mapping.get(source_hash)
    if dir_name and (type_dir / dir_name).exists():
        return str(type_dir / dir_name)
    return None


def _read_skill_name(skill_dir: Path) -> str:
    """Extract the skill name from SKILL.md YAML frontmatter."""
    content = (skill_dir / "SKILL.md").read_text()
    if not content.startswith("---"):
        raise ValueError(f"SKILL.md in {skill_dir} has no YAML frontmatter (must start with ---)")
    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"SKILL.md in {skill_dir} has malformed frontmatter (missing closing ---)")
    for line in parts[1].strip().splitlines():
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip("\"'")
            if name:
                return name
    raise ValueError(f"SKILL.md in {skill_dir} is missing a 'name' field in frontmatter")


def _pick_dir_name(type_dir: Path, name: str, source_hash: str) -> str:
    """Pick a unique directory name, appending a hash suffix on collision."""
    if not (type_dir / name).exists():
        return name
    return f"{name}-{source_hash[:8]}"


def _rename_and_cache_skill(type_dir: Path, temp_dir: Path, source_hash: str, skill_root: Path,
                            source_label: str = "") -> Path:
    """Validate SKILL.md, rename the temp dir to the skill's declared name, and update the map.

    Raises ValueError if SKILL.md is missing or has invalid frontmatter.
    """
    if not (skill_root / "SKILL.md").exists():
        _cleanup(temp_dir)
        hint = f" (source: {source_label})" if source_label else ""
        raise ValueError(f"No SKILL.md found in fetched skill{hint}")

    name = _read_skill_name(skill_root)
    dir_name = _pick_dir_name(type_dir, name, source_hash)
    final_dir = type_dir / dir_name
    if final_dir != temp_dir:
        temp_dir.rename(final_dir)

    mapping = _read_map(type_dir)
    mapping[source_hash] = dir_name
    _write_map(type_dir, mapping)
    return final_dir


def _fetch_s3_skill(source: str, s3_client=None) -> Path:
    """Download an s3:// skill prefix and return the local directory."""
    uri = source if source.endswith("/") else source + "/"
    source_hash = _stable_hash(uri)
    type_dir = _SKILLS_BASE / "s3"

    cached = _resolve_cached(type_dir, source_hash)
    if cached:
        return Path(cached)

    import boto3
    client = s3_client or boto3.client("s3")
    bucket, _, prefix = uri[len("s3://"):].partition("/")
    if not bucket:
        raise ValueError(f"Invalid S3 URI (no bucket): {uri}")

    temp_dir = type_dir / source_hash
    _cleanup(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_root = temp_dir.resolve()

    paginator = client.get_paginator("list_objects_v2")
    total = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            total += obj["Size"]
            if total > _S3_MAX_SIZE_BYTES:
                _cleanup(temp_dir)
                raise ValueError(f"S3 skill {uri} exceeds 1 GB size limit")
            rel = obj["Key"][len(prefix):].lstrip("/")
            if not rel:
                continue
            dest = (temp_dir / rel).resolve()
            if dest != temp_root and not str(dest).startswith(str(temp_root) + os.sep):
                _cleanup(temp_dir)
                raise ValueError(f"Path traversal detected in S3 key: {obj['Key']}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            client.download_file(bucket, obj["Key"], str(dest))

    if total == 0:
        _cleanup(temp_dir)
        raise ValueError(f"No files found at S3 URI: {uri}")

    return _rename_and_cache_skill(type_dir, temp_dir, source_hash, temp_dir, source_label=uri)


def _resolve_credential_arn(credential_arn: str, identity_client) -> str:
    """Resolve a Token Vault API-key credential ARN to its secret value via AgentCore Identity.

    ARN format: arn:<p>:bedrock-agentcore:<region>:<account>:token-vault/<vault>/apikeycredentialprovider/<name>
    """
    from bedrock_agentcore.runtime.context import BedrockAgentCoreContext  # noqa: PLC0415

    provider_name = credential_arn.rsplit("/", 1)[-1]
    if not provider_name:
        raise ValueError(f"Invalid credential ARN: {credential_arn}")
    workload_token = BedrockAgentCoreContext.get_workload_access_token()
    if not workload_token:
        raise ValueError("Credential ARN resolution requires a workload access token")
    api_key = identity_client.dp_client.get_resource_api_key(
        resourceCredentialProviderName=provider_name,
        workloadIdentityToken=workload_token,
    )["apiKey"]
    if not api_key:
        raise ValueError(f"Identity returned empty API key for provider: {provider_name}")
    return api_key


def _build_git_auth_env(credential_arn: Optional[str], username: Optional[str], identity_client=None) -> dict:
    """Build GIT_CONFIG_* env vars for HTTP Basic auth using a Token Vault credential ARN.

    Uses env vars instead of -c args to avoid leaking credentials in /proc/*/cmdline,
    and so auth propagates to sub-commands (e.g. sparse-checkout triggering a fetch).
    """
    if not credential_arn or not identity_client:
        return {}
    password = _resolve_credential_arn(credential_arn, identity_client)
    user = username or "oauth2"
    encoded = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {encoded}",
    }


def _fetch_git_skill(url: str, skill_path: str = "", credential_arn: Optional[str] = None,
                     username: Optional[str] = None, identity_client=None) -> Path:
    """Shallow-clone a git skill repository and return the local skill directory.

    Returns the directory containing SKILL.md (the subdir itself for sparse checkouts).
    """
    if skill_path and (os.path.isabs(skill_path) or ".." in Path(skill_path).parts):
        raise ValueError(f"Path traversal detected in skill path: {skill_path}")

    source_hash = _stable_hash(f"{url}:{skill_path}")
    type_dir = _SKILLS_BASE / "git"

    cached = _resolve_cached(type_dir, source_hash)
    if cached:
        return Path(cached) / skill_path if skill_path else Path(cached)

    temp_dir = type_dir / source_hash
    _cleanup(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)

    extra_env = _build_git_auth_env(credential_arn, username, identity_client)
    git_env = {**os.environ, **extra_env} if extra_env else None

    try:
        if skill_path:
            subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", url, str(temp_dir)],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, env=git_env,
            )
            subprocess.run(
                ["git", "sparse-checkout", "set", skill_path],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, cwd=str(temp_dir), env=git_env,
            )
        else:
            subprocess.run(
                ["git", "clone", "--depth", "1", url, str(temp_dir)],
                check=True, timeout=_GIT_TIMEOUT, capture_output=True, env=git_env,
            )
    except Exception:
        _cleanup(temp_dir)
        raise

    if skill_path and not (temp_dir / skill_path).exists():
        _cleanup(temp_dir)
        raise ValueError(f"Skill path '{skill_path}' not found in repository '{url}'")

    # SKILL.md lives inside the subdir for sparse checkouts.
    skill_root = temp_dir / skill_path if skill_path else temp_dir
    label = f"{url}:{skill_path}" if skill_path else url
    final_dir = _rename_and_cache_skill(type_dir, temp_dir, source_hash, skill_root, source_label=label)
    return final_dir / skill_path if skill_path else final_dir


def resolve_s3_skills(sources: list, s3_client=None) -> list:
    """Resolve s3:// skill URIs to local filesystem paths.

    Any fetch failure raises and fails the invocation — a partial skill set
    would silently run the agent without capabilities the harness declared.
    """
    paths = []
    for uri in sources:
        try:
            skill_dir = _fetch_s3_skill(uri, s3_client)
        except Exception as e:
            raise ValueError(f"Failed to resolve S3 skill '{uri}': {e}") from e
        paths.append(str(skill_dir.resolve()))
    return paths


def resolve_git_skills(sources: list, identity_client=None) -> list:
    """Resolve git skill dicts to local filesystem paths.

    Each source is a dict with keys: url (required), path (optional),
    credentialArn (optional), username (optional).

    Any fetch failure raises and fails the invocation — a partial skill set
    would silently run the agent without capabilities the harness declared.
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
        except Exception as e:
            raise ValueError(f"Failed to resolve git skill '{source.get('url', source)}': {e}") from e
        paths.append(str(skill_dir.resolve()))
    return paths
