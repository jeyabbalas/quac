// Canonical QCFlag — defined once here, shared by the schema and rules engines
// (architecture.md §5). Created in P10 (rules types reference it); P08 builds
// flagStore.ts / messages.ts around it.
export interface QCFlag {
  source: 'schema' | 'rules';
  ruleId: string; // e.g. 'schema:prop:age:value' | 'Q003'
  scope: 'cell' | 'row' | 'column' | 'dataset';
  row?: number; // __row__ (cell/row scope)
  column?: string; // (cell/column scope)
  severity: 'error' | 'warning' | 'info';
  message: string; // self-contained sentence; EXCLUDES column name and ruleId
  value?: unknown; // offending value snapshot (cell scope)
  correction?: { before: unknown; after: unknown };
  meta?: { keyword?: string; schemaPath?: string; conditionalIndex?: number };
}
