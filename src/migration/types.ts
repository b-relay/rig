import type { RuntimeState } from "../domain/runtime";
export interface MigrationIssue {
  code: string;
  message: string;
  project?: string;
  target?: string;
}
export interface LegacyFile {
  path: string;
  relativePath: string;
  revision: string;
  bytes: number;
}
export interface ProcessAdoption {
  project: string;
  target: string;
  component: string;
  key: string;
  provider: string;
  legacyLabel?: string;
  status: "requires-adoption";
  reason: string;
}
export interface RouteAdoption {
  project: string;
  target: string;
  component: string;
  key: string;
  legacyMarker: string;
  hostname: string;
  upstream: string;
  status: "requires-adoption";
}
export interface RecoveredSource {
  project: string;
  target: string;
  branch: string;
  commit: string;
  evidence: string;
}
export interface MigrationReadOptions {
  recoveredSources?: readonly RecoveredSource[];
}
export interface MigrationWriteOptions extends MigrationReadOptions {
  expectedRevision: string;
}
export interface MigrationPreview {
  revision: string;
  files: LegacyFile[];
  projects: { name: string; repoPath: string; configPath: string }[];
  targets: {
    project: string;
    name: string;
    kind: string;
    workspacePath: string;
    desired: string;
  }[];
  issues: MigrationIssue[];
  warnings: MigrationIssue[];
  recoveredSources: RecoveredSource[];
  state?: RuntimeState;
  adoption: { processes: ProcessAdoption[]; routes: RouteAdoption[] };
  history: {
    events: number;
    acceptedReceipts: number;
    failures: number;
    preservation: "original-files-and-exact-backups";
  };
}
