import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as diff from 'diff';
import { PatchConflictError, SecurityBoundaryError } from '../shared/errors.js';
import type { DiffHunk, StagedFilePatch } from '../shared/types.js';

export class PatchStagingManager {
  private stagedPatches = new Map<string, StagedFilePatch>();

  constructor(private readonly workspaceRoot: string) {}

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public assertInsideWorkspace(targetPath: string): string {
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);

    if (!resolved.startsWith(this.workspaceRoot + path.sep) && resolved !== this.workspaceRoot) {
      throw new SecurityBoundaryError(targetPath, this.workspaceRoot);
    }
    return resolved;
  }

  public computeSha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  public stagePatch(options: {
    filePath: string;
    proposedContent: string;
    purpose: string;
    rationale: string;
    expectedImpact?: string;
    riskLevel?: "low" | "medium" | "high";
    existingContent?: string;
  }): StagedFilePatch {
    const absolutePath = this.assertInsideWorkspace(options.filePath);
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    const originalContent = options.existingContent ?? '';

    const patchId = `patch_${crypto.randomUUID().slice(0, 8)}`;
    const originalSha = this.computeSha256(originalContent);
    const proposedSha = this.computeSha256(options.proposedContent);

    const unifiedDiff = diff.createTwoFilesPatch(
      relativePath,
      relativePath,
      originalContent,
      options.proposedContent,
      'original',
      'proposed'
    );

    const parsed = diff.parsePatch(unifiedDiff);
    const rawHunks = parsed[0]?.hunks ?? [];

    const hunks: DiffHunk[] = rawHunks.map((h, idx) => ({
      hunkId: `${patchId}_hunk_${idx + 1}`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: h.lines,
      accepted: true,
    }));

    const staged: StagedFilePatch = {
      patchId,
      filePath: relativePath,
      absolutePath,
      originalSha256: originalSha,
      proposedSha256: proposedSha,
      originalContent,
      proposedContent: options.proposedContent,
      unifiedDiff,
      hunks,
      purpose: options.purpose,
      rationale: options.rationale,
      expectedImpact: options.expectedImpact ?? 'Precise targeted change satisfying requirement.',
      riskLevel: options.riskLevel ?? 'low',
      status: 'staged',
      createdAt: new Date().toISOString(),
    };

    this.stagedPatches.set(patchId, staged);
    return staged;
  }

  public getPatch(patchId: string): StagedFilePatch | undefined {
    return this.stagedPatches.get(patchId);
  }

  public getAllStaged(): StagedFilePatch[] {
    return Array.from(this.stagedPatches.values());
  }

  public setHunkDecision(patchId: string, hunkId: string, accepted: boolean): boolean {
    const patch = this.stagedPatches.get(patchId);
    if (!patch) return false;
    const hunk = patch.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) return false;
    hunk.accepted = accepted;
    return true;
  }

  public setPatchDecision(patchId: string, decision: 'accept' | 'reject'): StagedFilePatch | undefined {
    const patch = this.stagedPatches.get(patchId);
    if (!patch) return undefined;
    patch.status = decision === 'accept' ? 'accepted' : 'rejected';
    for (const hunk of patch.hunks) {
      hunk.accepted = decision === 'accept';
    }
    return patch;
  }

  public async applyPatch(patchId: string): Promise<{ appliedContent: string; relativePath: string }> {
    const patch = this.stagedPatches.get(patchId);
    if (!patch) {
      throw new Error(`Patch with ID "${patchId}" not found in staging.`);
    }

    let currentContent = '';
    try {
      currentContent = await fs.readFile(patch.absolutePath, 'utf8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      currentContent = '';
    }

    const currentSha = this.computeSha256(currentContent);
    if (patch.originalContent !== '' && currentSha !== patch.originalSha256) {
      throw new PatchConflictError(patch.filePath, patch.originalSha256, currentSha);
    }

    const allAccepted = patch.hunks.every((h) => h.accepted !== false);
    let finalContent = patch.proposedContent;

    if (!allAccepted) {
      const acceptedHunks = patch.hunks.filter((h) => h.accepted);
      if (acceptedHunks.length === 0) {
        patch.status = 'rejected';
        return { appliedContent: currentContent, relativePath: patch.filePath };
      }
      const appliedResult = diff.applyPatch(patch.originalContent, {
        hunks: acceptedHunks.map((h) => ({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          lines: h.lines,
        })),
      } as any);
      if (appliedResult === false) {
        throw new Error(`Failed to apply selective hunks to "${patch.filePath}".`);
      }
      finalContent = appliedResult;
    }

    await fs.mkdir(path.dirname(patch.absolutePath), { recursive: true });
    await fs.writeFile(patch.absolutePath, finalContent, 'utf8');
    patch.status = 'applied';
    return { appliedContent: finalContent, relativePath: patch.filePath };
  }

  public async revertPatch(patchId: string): Promise<void> {
    const patch = this.stagedPatches.get(patchId);
    if (!patch) {
      throw new Error(`Patch with ID "${patchId}" not found.`);
    }
    if (patch.originalContent === '') {
      await fs.rm(patch.absolutePath, { force: true });
    } else {
      await fs.writeFile(patch.absolutePath, patch.originalContent, 'utf8');
    }
    patch.status = 'reverted';
  }

  public clear(): void {
    this.stagedPatches.clear();
  }
}

