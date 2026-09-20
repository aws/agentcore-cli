"""Package the dependency-free example as a deterministic Python runtime ZIP."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
output = root / "dist" / "agent.zip"
output.parent.mkdir(exist_ok=True)
entry = ZipInfo("agent.py", date_time=(1980, 1, 1, 0, 0, 0))
entry.compress_type = ZIP_DEFLATED
entry.external_attr = 0o644 << 16
with ZipFile(output, "w") as archive:
    archive.writestr(entry, (root / "agent.py").read_bytes())
print(output)
