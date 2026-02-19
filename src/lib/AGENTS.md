# Lib Module

The `lib` module contains functionalities and utilities that are used by both the `cli` and the `cdk` modules. This
module serves the important goal of making sure that the CDK implementations don't take a direct dependency on the CLI.

## Functions

**Packaging**: Producing deployment artifacts for AgentCore runtimes. Two packagers are available:

- **PythonPackager / NodePackager** (CodeZip): Installs dependencies and produces a `.zip` artifact targeting ARM64
  architecture.
- **ContainerPackager** (Container): Validates the Dockerfile exists, detects a local container runtime
  (Docker/Podman/Finch), builds the image locally, and validates the 1GB size limit. If no local runtime is available,
  the local build is skipped (deploy uses CodeBuild).

Container constants (`CONTAINER_RUNTIMES`, `DOCKERFILE_NAME`, `CONTAINER_INTERNAL_PORT`) and the `ContainerRuntime` type
are in `lib/constants.ts`.

**ConfigIO**: This module defines utilities to read and write configs which satisfy schemas to the local file system.
Both the CLI and the CDK require this functionality.

**Util**: Subprocess command utilities, zod utilities, and OS utilities.

## Cross-Platform Support

The CLI is designed to work on both Windows and Unix-like systems (Linux, macOS). Platform-specific differences are
abstracted through utilities in `lib/utils/platform.ts`.

### Platform Utilities

**Key utilities for cross-platform development:**

- `isWindows`, `isMacOS`, `isLinux` - Platform detection flags
- `getVenvExecutable(venvPath, executable)` - Get correct path to Python venv executables
  - Unix: `.venv/bin/python`, `.venv/bin/uvicorn`
  - Windows: `.venv\Scripts\python.exe`, `.venv\Scripts\uvicorn.exe`
- `getShellCommand()` - Get platform-appropriate shell command
- `getShellArgs(command)` - Get platform-appropriate shell arguments
- `normalizeCommand(command)` - Add .exe extension on Windows when needed

### Guidelines for Cross-Platform Code

1. **Never hardcode Unix paths** - Use `getVenvExecutable()` for Python venv paths
2. **Use platform utilities** - Import from `lib/utils/platform` instead of checking `process.platform` directly
3. **Test on both platforms** - Ensure features work on Windows and Unix
4. **Avoid Unix-specific commands** - Use Node.js APIs or cross-platform alternatives (e.g., Node.js fs instead of
   `rm -rf`)
5. **Document platform differences** - Add comments explaining platform-specific behavior

### Example

```typescript
import { getVenvExecutable, isWindows } from '../lib/utils/platform';

// ❌ BAD: Hardcoded Unix path
const uvicorn = join(venvPath, 'bin', 'uvicorn');

// ✅ GOOD: Cross-platform
const uvicorn = getVenvExecutable(venvPath, 'uvicorn');
// Returns: .venv/bin/uvicorn on Unix, .venv\Scripts\uvicorn.exe on Windows
```

## Future Direction

Functionality such as imperative code implementations to write secret values into the AgentCore Identity primitive would
be well-suited for this module.
