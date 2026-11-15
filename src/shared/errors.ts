export class SentinelError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = 'SentinelError';
  }
}

export class SecurityBoundaryError extends SentinelError {
  constructor(pathStr: string, boundary: string) {
    super(
      `Security Violation: Path "${pathStr}" attempts to escape allowed workspace root "${boundary}".`,
      'ERR_SECURITY_BOUNDARY'
    );
  }
}

export class PatchConflictError extends SentinelError {
  constructor(filePath: string, expectedSha: string, actualSha: string) {
    super(
      `Patch Application Failed: File "${filePath}" has been modified externally (expected SHA: ${expectedSha.slice(0, 8)}, actual SHA: ${actualSha.slice(0, 8)}).`,
      'ERR_PATCH_CONFLICT'
    );
  }
}

export class TrueForgeConnectionError extends SentinelError {
  constructor(url: string, cause?: unknown) {
    super(
      `TrueForge Harness Unreachable: Failed to connect to local TrueForge instance at "${url}". Ensure local daemon is running (npx @truefoundry/trueforge).`,
      'ERR_TRUEFORGE_UNREACHABLE',
      cause
    );
  }
}
